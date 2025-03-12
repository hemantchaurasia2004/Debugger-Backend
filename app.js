const express = require('express');
const bodyParser = require('body-parser');
const OpenAI = require('openai');
const _ = require('lodash');
dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post('/api/analyze-prompt', async (req, res) => {
  try {
    const {
      conversationHistory,
      targetBotResponse,
      userFeedback,
      executionContext,
      configuredPrompts,
      knowledgeBaseUrls
    } = req.body;

    if (!conversationHistory || !targetBotResponse || !userFeedback || !configuredPrompts) {
      return res.status(400).json({
        error: 'Missing required fields. Provide conversationHistory, targetBotResponse, userFeedback, and configuredPrompts.'
      });
    }

    const requiredPrompts = ['AGENT', 'KNOWLEDGE_BASE', 'CONVERSATION'];
    const missingPrompts = requiredPrompts.filter(prompt => !configuredPrompts[prompt]);

    if (missingPrompts.length > 0) {
      return res.status(400).json({
        error: `Missing required prompts: ${missingPrompts.join(', ')}`
      });
    }

    const analysisPrompt = buildAnalysisPrompt(
      conversationHistory,
      targetBotResponse,
      userFeedback,
      executionContext,
      configuredPrompts,
      knowledgeBaseUrls
    );

    const analysis = await analyzeLLMPrompt(analysisPrompt);
    const validatedResponse = validateAnalysisResponse(analysis);

    return res.status(200).json(validatedResponse);
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'An error occurred during prompt analysis',
      details: error.message
    });
  }
});

function buildAnalysisPrompt(conversationHistory, targetBotResponse, userFeedback, executionContext, configuredPrompts, knowledgeBaseUrls) {
  return `
# INTRODUCTION
  - You are an AI assistant which helps the user modify the prompt instructions based on their feedback on some previous conversation.
  - You are an expert in writing Prompt instructions for a LLM. Each of your instructions must be very clear to understand and must not be ambiguous.
  - You must go through the entire prompt before you start modifying the instructions.
  - You should first try to understand the user's feedback and the reason why the assistant didn't behave as expected by the user. Only then you should modify the instructions.
  - You must not add a conflicting instruction with the existing instructions. Replace the conflicting instruction with the new one.

# PURPOSE
  - You are given with all the available details below for the user feedback on certain response of the assistant.
  - You must take your time and respond with your analysis and the prompt modifications required based on the user feedback.

# IMPORTANT ARCHITECTURAL DETAILS FOR UNDERSTANDING
  - On a high level, there are 2 components involved in the conversation: AGENT & TOOLS
  - AGENT
    - This is the first layer of LLM through which all the user messages pass through.
    - It has access to different types of tools which can handle different type of user queries or requests.
    - Based on the current user message and conversation history, the AGENT decides which tool should be used to handle the current user query.
  - TOOLS
    - These are the second layer of LLM which are specialized in handling specific type of user queries or requests.
    - There are only 5 types of tools: KNOWLEDGE_BASE, CONVERSATION, SMALLTALK, GENERIC_QUERY & FALLBACK
    - KNOWLEDGE_BASE: This is a system defined tool which can answer the user query by referring to a FAQ document or a website. This usually contain urls to websites with information fed.
    - CONVERSATION: There can be multiple instances of this tool with different ids in the chatbot. These are user defined tools to handle a use case or a flow. E.g. Book a flight, Book a hotel, Cancel flight etc..
    - SMALLTALK: This is a system defined tool which can handle user queries like greetings, goodbyes, thanks etc..
    - GENERIC_QUERY: This is a system defined tool which can handle generic user queries which are out of scope.
    - FALLBACK: This is a system defined tool which is used when the user query falls in the scope of the bot but no tool is available to handle it.
  - For a user message, only one tool can generate the bot response. The AGENT decides which tool should be used.
  - Response for the tools SMALLTALK and GENERIC_QUERY are generated by the AGENT itself. The response for the tools KNOWLEDGE_BASE and CONVERSATION are generated by the respective tools.
  - Make changes in the agent prompt only if the user feedback is related to SMALLTALK, GENERIC_QUERY, or the FALLBACK tool.

***IMPORTANT NOTES***: It is encouraged that the model to articulate its reasoning process step-by-step when identifying issues.\n The model before generating the responses should generate multiple critiques or alternative solutions and verify them against each other and then should output the best one (Without reflecting them in the responses. DO CARRY OUT THE SELF CRITIQUE STEP.).

# CONVERSATION HISTORY TILL THAT MESSAGE
${JSON.stringify(conversationHistory, null, 2)}

# TARGETED BOT RESPONSE
${JSON.stringify(targetBotResponse, null, 2)}

# USER FEEDBACK ON THE TARGET BOT RESPONSE
${JSON.stringify(userFeedback, null, 2)}

# IMPORTANT LOGS AND REASONING FOR THE TARGETED USER MESSAGE PROCESSING
${JSON.stringify(executionContext || {}, null, 2)}

# CONFIGURED PROMPTS USED BY DIFFERENT COMPONENTS
## AGENT
${configuredPrompts.AGENT}

## KNOWLEDGE_BASE
${configuredPrompts.KNOWLEDGE_BASE}

## CONVERSATION
${configuredPrompts.CONVERSATION}


# OUTPUT
- You must respond with the prompt modifications required based on the user feedback.
- Your response should be in valid JSON format matching the schema:
{
      "type": "object",
      "properties": {
        "gapAnalysis": {
          "type": "string",
          "description": "Detailed analysis of the user feedback and the reason why the assistant didn't behave as expected by the user"
        },
        "promptChanges": {
          "type": "object",
          "description": "Prompt modifications required based on the user feedback",
          "properties": {
            "modifications": {
              "type": "array",
              "description": "List of instructions to be modified in a component",
              "items": {
                "type": "object",
                "properties": {
                  "component": {
                    "type": "string",
                    "description": "Component type where the instruction is to be modified",
                    "enum": ["AGENT", "KNOWLEDGE_BASE", "CONVERSATION"]
                  },
                  "path": {
                    "type": "string",
                    "description": "Full Path of the field inside the component prompt in which the instruction to be modified"
                  },
                  "current": {
                    "type": "string",
                    "description": "Current instruction text to be replaced"
                  },
                  "updated": {
                    "type": "string",
                    "description": "Updated instruction text"
                  },
                  "reasoning": {
                    "type": "string",
                    "description": "Detailed reasoning for the modification"
                  }
                }
              }
            },
            "deletions": {
              "type": "array",
              "description": "List of instructions to be deleted from a component",
              "items": {
                "type": "object",
                "properties": {
                  "component": {
                    "type": "string",
                    "description": "Component type where the instruction is to be deleted",
                    "enum": ["AGENT", "KNOWLEDGE_BASE", "CONVERSATION"]
                  },
                  "path": {
                    "type": "string",
                    "description": "Full Path of the field inside the component prompt from which the instruction needs to be deleted"
                  },
                  "instructionText": {
                    "type": "string",
                    "description": "Current instruction text to be deleted"
                  },
                  "reasoning": {
                    "type": "string",
                    "description": "Detailed reasoning for the deletion"
                  }
                }
              }
            },
            "additions": {
              "type": "array",
              "description": "List of instructions to be added in a component",
              "items": {
                "type": "object",
                "properties": {
                  "component": {
                    "type": "string",
                    "description": "Component type in which the instruction needs to be added",
                    "enum": ["AGENT", "KNOWLEDGE_BASE", "CONVERSATION"]
                  },
                  "path": {
                    "type": "string",
                    "description": "Full Path of the field inside the component prompt where the new instructions are to be added"
                  },
                  "preText": {
                    "type": "string",
                    "description": "Instruction text after which the new instruction is to be added"
                  },
                  "newInstruction": {
                    "type": "string",
                    "description": "New instructions to be added"
                  },
                  "reasoning": {
                    "type": "string",
                    "description": "Reasoning for adding the new instructions"
                  }
                }
              }
            }
          }
        },
        "updatedPrompt": {
          "type": "object",
          "description": "Updated prompt in the same JSON format as the configured prompt. Only the instructions must be modified.",
          "properties": {
            "AGENT": {
              "type": "string",
              "description": "Full Updated agent prompt"
            },
            "KNOWLEDGE_BASE": {
              "type": "string",
              "description": "Full Updated knowledge base prompt"
            },
            "CONVERSATION": {
              "type": "string",
              "description": "Full Updated conversation prompt"
            }
          }
        },
        "expectedImpact": {
          "type": "string",
          "description": "Detailed Impact expectation report of the prompt modifications on the assistant's behavior and what all things should be tested after the modifications"
        }
      }
    }`;
}

async function analyzeLLMPrompt(prompt) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 1,
    max_completion_tokens: 4000
  });

  return response.choices[0].message.content;
}

function validateAnalysisResponse(analysisString) {
  const jsonMatch = analysisString.match(/\{[\s\S]*\}/);
  if (jsonMatch) return JSON.parse(jsonMatch[0]);
  throw new Error('LLM response is not valid JSON');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Prompt Debugger API running on port ${PORT}`);
});

module.exports = app;
