// server.js - "The Python Mirror"
// This code copies the EXACT settings from your working Python script.

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ------------------------------------------------------------------
// 1. HARDCODED CONFIGURATION (Matches your Python Script exactly)
// ------------------------------------------------------------------
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

// We hardcode the key to rule out "Environment Variable" errors
const NIM_API_KEY = "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";

const TARGET_MODEL = "deepseek-ai/deepseek-v3.2";
const ENABLE_THINKING = true;

// ------------------------------------------------------------------
// 2. SERVER ROUTES
// ------------------------------------------------------------------

app.get('/health', (req, res) => res.json({ status: 'ok', msg: 'Proxy Live' }));

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [{ id: TARGET_MODEL, object: 'model', created: Date.now(), owned_by: 'nvidia' }]
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    console.log(`[Proxy] New Request. Mapping to: ${TARGET_MODEL}`);

    // 1. Prepare Request (Exactly matching Python parameters)
    const nimRequest = {
      model: TARGET_MODEL,
      messages: req.body.messages,
      // Python used temperature=1, top_p=0.95
      temperature: 1, 
      top_p: 0.95,
      max_tokens: 8192,
      stream: true, // Force stream to prevent timeouts
      
      // The parameter that enables reasoning
      chat_template_kwargs: { thinking: true }
    };

    // 2. Send to NVIDIA
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream' // We must use stream to handle the thinking process
    });

    // 3. Setup Stream Response to Janitor
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let buffer = '';
    let reasoningStarted = false;

    // 4. Process the Stream
    response.data.on('data', (chunk) => {
      // Decode chunk
      const text = chunk.toString();
      buffer += text;
      
      // Process full lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line

      lines.forEach(line => {
        if (!line.startsWith('data: ')) return;
        if (line.includes('[DONE]')) {
          res.write(line + '\n\n');
          return;
        }

        try {
          // Parse JSON
          const jsonStr = line.replace('data: ', '');
          const data = JSON.parse(jsonStr);
          
          if (data.choices && data.choices.length > 0) {
            const delta = data.choices[0].delta;
            
            // Logic: Capture "reasoning_content" and turn it into standard "content" for Janitor
            // This matches the Python script's print logic
            if (delta.reasoning_content) {
                if (!reasoningStarted) {
                    // Start of thinking
                    delta.content = '<think>\n' + delta.reasoning_content;
                    reasoningStarted = true;
                } else {
                    // Continuing thinking
                    delta.content = delta.reasoning_content;
                }
                // IMPORTANT: Remove reasoning_content so we don't send it twice
                delete delta.reasoning_content;
            } else if (delta.content) {
                if (reasoningStarted) {
                    // End of thinking, start of normal text
                    delta.content = '</think>\n\n' + delta.content;
                    reasoningStarted = false;
                }
                // Else: normal text
            }
          }

          // Write back to Janitor
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
          // Ignore parse errors for keep-alive packets
        }
      });
    });

    response.data.on('end', () => res.end());
    
    response.data.on('error', (err) => {
      console.error('Stream Error:', err);
      res.end();
    });

  } catch (error) {
    console.error('Connection Error:', error.message);
    if (error.response) {
       console.error('Nvidia Response:', error.response.status, error.response.statusText);
       // Try to log data if possible
       try { console.error('Data:', JSON.stringify(error.response.data)); } catch(e){}
    }
    
    // If we haven't started streaming, send JSON error
    if (!res.headersSent) {
      res.status(500).json({ error: { message: "Proxy Connection Failed", code: 500 } });
    } else {
      res.end();
    }
  }
});

// Catch-all
app.all('*', (req, res) => res.status(404).json({ error: "Use /v1/chat/completions" }));

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
