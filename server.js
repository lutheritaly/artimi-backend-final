import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

// Enable wide-open CORS and JSON parsing out of the box
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// Main entry point for the keypad
app.post('/api/interact', async (req, res) => {
  try {
    const { artifactId, code, userInput, lang = 'IT' } = req.body;
    const targetLang = lang.toUpperCase();
    
    // 1. Fetch Master Control Center Spreadsheet via raw CSV stream
    const sheetId = '1TsAL7FIg0HRqFl92s-6Ag-Wxtbbe9-qzeB9Fw7L3wKA'; 
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`; 
    const sheetResponse = await fetch(sheetUrl);
    
    if (!sheetResponse.ok) throw new Error('Failed to retrieve control sheet maps.');
    const csvData = await sheetResponse.text();
    
    const rows = csvData.split('\n').map(row => {
      return row.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
    });

    const targetRow = rows.find(r => {
      const cleanA = r[0]?.replace(/"/g, '').trim();
      const cleanU = r[20]?.replace(/"/g, '').trim(); 
      return cleanA === String(artifactId) || cleanU === String(code);
    });

    if (!targetRow) {
      return res.status(404).json({ error: 'Artifact code missing from registry.' });
    }

    const artifactName = targetRow[1]?.replace(/"/g, '').trim(); 
    const docLink = targetRow[3]?.replace(/"/g, '').trim();      
    
    const monologues = {
      IT: targetRow[4]?.replace(/"/g, '').trim(),  
      EN: targetRow[5]?.replace(/"/g, '').trim(),  
      ES: targetRow[13]?.replace(/"/g, '').trim(), 
      FR: targetRow[14]?.replace(/"/g, '').trim()  
    };

    const brainPlatform = targetRow[15]?.replace(/"/g, '').trim(); 
    const brainModel = targetRow[16]?.replace(/"/g, '').trim();    
    const voicePlatform = targetRow[17]?.replace(/"/g, '').trim();  
    const voiceId = targetRow[18]?.replace(/"/g, '').trim();        

    // 2. Resolve Deep Historical Context Document
    let historicalContext = '';
    if (docLink && docLink.includes('docs.google.com/document')) {
      const docIdMatch = docLink.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (docIdMatch) {
        const docTxtUrl = `https://docs.google.com/document/d/${docIdMatch[1]}/export?format=txt`;
        const docResponse = await fetch(docTxtUrl);
        if (docResponse.ok) historicalContext = await docResponse.text();
      }
    }

    // 3. Assemble Prompt
    const systemPrompt = `You are the unscripted, living voice of the museum artifact: "${artifactName}". 
    Historical truth baseline: ${historicalContext}
    RULES: 1. Respond exclusively in: ${targetLang}. 2. Keep response short and limited to exactly 2 sentences.`;

    let aiTextResponse = '';

    // 4. Brain Processing
    if (brainPlatform && brainPlatform.toLowerCase() === 'groq') {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: brainModel || 'llama3-8b-8192', 
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userInput }],
          max_tokens: 150,
          temperature: 0.7
        })
      });
      const groqData = await groqRes.json();
      aiTextResponse = groqData.choices[0]?.message?.content || '';
    } else if (brainPlatform && brainPlatform.toLowerCase() === 'gemini') {
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${brainModel || 'gemini-1.5-flash'}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nVisitor: ${userInput}` }] }]
        })
      });
      const geminiData = await geminiRes.json();
      aiTextResponse = geminiData.candidates[0]?.content?.parts[0]?.text || '';
    } else {
      throw new Error(`Unsupported brain target: ${brainPlatform}`);
    }

    // 5. Audio Pipeline
    let audioUrl = null;
    if (voicePlatform && voicePlatform.toLowerCase() === 'deepgram') {
      const selectedVoice = voiceId || 'aura-2-thalia-it'; 
      const responseVoice = await fetch(`https://api.deepgram.com/v1/speak?model=${selectedVoice}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DEEPGRAM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text: aiTextResponse })
      });

      if (responseVoice.ok) {
        const arrayBuffer = await responseVoice.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        audioUrl = `data:audio/mp3;base64,${buffer.toString('base64')}`;
      }
    }

    return res.status(200).json({
      artifactId: targetRow[0]?.replace(/"/g, '').trim(),
      artifactName,
      text: aiTextResponse.trim(),
      audioUrl: audioUrl,
      initialMonologue: monologues[targetLang] || monologues['EN'],
      languageUsed: targetLang
    });

  } catch (error) {
    console.error('Failure:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

app.listen(PORT, () => console.log(`Server running smoothly on port ${PORT}`));