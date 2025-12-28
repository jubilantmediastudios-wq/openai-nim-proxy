// server.js - Robust Version with Error Stream Reading
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// CONSTANTS
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// SETTINGS
const SHOW_REASONING = true;
const ENABLE_THINKING_MODE = true; 

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DeepSeek Proxy' });
});

// CHAT ENDPOINT
app.post('/v1/chat/completions', async (req, res) => {
  // 1. Determine Model
  let modelInput = req.body.model.toLowerCase();
  let targetModel = 'deepseek-ai/deepseek-v3.2'; // Default target
  
  // If user asks for R1 specifically, or if we want to default to it for safety
  if (modelInput.includes('r1')) {
      targetModel = 'deepseek-ai/deepseek-r1';
  }

  // 2. Build Request
  const nimRequest = {
    model: targetModel,
    messages: req.body.messages,
    temperature: req.body.temperature || 0.6,
    max_tokens: req.body.max_tokens || 8192,
    stream: req.body.stream || false,
    chat_template_kwargs: { thinking: true } // Direct injection
  };

  console.log(`[Proxy] Sending to NVIDIA: ${targetModel}`);

  try {
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      // IMPORTANT: We request a stream, but if it errors, we must handle the error stream
      responseType: req.body.stream ? 'stream' : 'json'
    });

    // 3. Handle Success (Streaming)
    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      response.data.pipe(res);
    } 
    // 4. Handle Success (Non-Streaming)
    else {
      res.json(response.data);
    }

  } catch (error) {
    // ==================================================
    // 🛑 ERROR HANDLING (Fixed to prevent crashes)
    // ==================================================
    let errorMessage = error.message;
    let errorBody = "No body";

    // If the error response is a stream (because of responseType: 'stream'), we must read it
    if (error.response && error.response.data && error.response.data.read) {
        try {
            // Read the stream into a string
            const chunks = [];
            for await (const chunk of error.response.data) {
                chunks.push(Buffer.from(chunk));
            }
            errorBody = Buffer.concat(chunks).toString('utf8');
            errorMessage = `NVIDIA Error ${error.response.status}: ${errorBody}`;
        } catch (readErr) {
            errorBody = "Could not read error stream";
        }
    } else if (error.response && error.response.data) {
        // Standard JSON error
        errorBody = JSON.stringify(error.response.data);
        errorMessage = `NVIDIA Error ${error.response.status}: ${errorBody}`;
    }

    console.error("=============== ERROR LOG ===============");
    console.error(errorMessage);
    console.error("=========================================");

    // If it was a 404 on v3.2, user might need to switch to R1
    if (error.response?.status === 404 && targetModel.includes('v3.2')) {
        console.log("💡 TIP: deepseek-v3.2 gave 404. Try changing code to use 'deepseek-ai/deepseek-r1'");
    }

    // Send safe JSON back to Janitor
    if (!res.headersSent) {
        res.status(error.response?.status || 500).json({
            error: {
                message: "Proxy Error: " + errorMessage,
                type: 'invalid_request_error',
                code: error.response?.status || 500
            }
        });
    }
  }
});

app.all('*', (req, res) => res.status(404).json({ error: "Endpoint not found" }));

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
