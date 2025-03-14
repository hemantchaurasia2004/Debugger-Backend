const express = require('express');
const bodyParser = require('body-parser');
const OpenAI = require('openai');
const _ = require('lodash');
const cors = require('cors');
dotenv = require('dotenv');
dotenv.config();

const app = express();

// Configure CORS
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400 // 24 hours
}));

// Add OPTIONS handler for preflight requests
app.options('/api/analyze-prompt', (req, res) => {
  res.status(200).end();
});


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
      knowledgeBaseUrls,
      isAgenticBot = true // New boolean parameter to differentiate bot types
    } = req.body;

    if (!conversationHistory || !targetBotResponse || !userFeedback) {
      return res.status(400).json({
        error: 'Missing required fields. Provide conversationHistory, targetBotResponse, and userFeedback.'
      });
    }

    // Validate required prompts based on bot type
    if (isAgenticBot) {
      const requiredPrompts = ['AGENT', 'KNOWLEDGE_BASE', 'CONVERSATION'];
      const missingPrompts = requiredPrompts.filter(prompt => !configuredPrompts[prompt]);

      if (missingPrompts.length > 0) {
        return res.status(400).json({
          error: `Missing required prompts for Agentic Bot: ${missingPrompts.join(', ')}`
        });
      }
    } else {
      // For NLP Bot, require system prompt
      if (!configuredPrompts.SYSTEM_PROMPT) {
        return res.status(400).json({
          error: 'Missing required SYSTEM_PROMPT for NLP Bot'
        });
      }
    }

    const analysisPrompt = buildAnalysisPrompt(
      conversationHistory,
      targetBotResponse,
      userFeedback,
      executionContext,
      configuredPrompts,
      knowledgeBaseUrls,
      isAgenticBot
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

function buildAnalysisPrompt(
  conversationHistory, 
  targetBotResponse, 
  userFeedback, 
  executionContext, 
  configuredPrompts, 
  knowledgeBaseUrls, 
  isAgenticBot
) {
  // Common prompt sections
  const introduction = `
# INTRODUCTION
 - You are an AI assistant which helps the user modify the prompt instructions based on their feedback on some previous conversation.
 - You are an expert in writing Prompt instructions for a LLM. Each of your instructions must be very clear to understand and must not be ambiguous.
 - You must go through the entire prompt before you start modifying the instructions.
 - You should first try to understand the user's feedback and the reason why the assistant didn't behave as expected by the user. Only then you should modify the instructions.
 - You must not add a conflicting instruction with the existing instructions. Replace the conflicting instruction with the new one.

# PURPOSE
 - You are given with all the available details below for the user feedback on certain response of the assistant.
 - You must take your time and respond with your analysis and the prompt modifications required based on the user feedback.`;

  // Bot type specific architectural details
  let architecturalDetails = '';
  let configuredPromptsSection = '';
  let outputSchema = '';

  if (isAgenticBot) {
    // Agentic Bot architecture
    architecturalDetails = `
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
 - Make changes in the agent prompt only if the user feedback is related to SMALLTALK, GENERIC_QUERY, or the FALLBACK tool.`;

    // Configured prompts section for Agentic Bot
    configuredPromptsSection = `
# CONFIGURED PROMPTS USED BY DIFFERENT COMPONENTS
## AGENT
${configuredPrompts.AGENT || 'Not provided'}

## KNOWLEDGE_BASE
${configuredPrompts.KNOWLEDGE_BASE || 'Not provided'}

## CONVERSATION
${configuredPrompts.CONVERSATION || 'Not provided'}`;

    // Output schema for Agentic Bot
    outputSchema = `
    {
      "type": "object",
      "properties": {
        "gapAnalysis": {
          "type": "string",
          "description": "Detailed analysis of the user feedback, the reason why the assistant didn't behave as expected, and an assessment of the prompt's effectiveness in achieving the conversational goal."
        },
        "promptAnalysis": {
          "type": "object",
          "description": "Analysis of the prompt fed to the bot, checking for clarity, hallucination risks, logical consistency, and missing elements.",
          "properties": {
            "objectiveClarity": {
              "type": "string",
              "description": "Evaluation of whether the purpose of the prompt is clearly stated and well-defined."
            },
            "requiredDataCollection": {
              "type": "string",
              "description": "Assessment of whether the bot is collecting all necessary details from the user to achieve the conversational goal."
            },
            "logicalFlow": {
              "type": "string",
              "description": "Analysis of the logical coherence of the prompt's instructions and whether they contradict each other."
            },
            "hallucinationRisk": {
              "type": "string",
              "description": "Assessment of whether the bot might generate misleading or fabricated information based on the prompt."
            },
            "errorHandling": {
              "type": "string",
              "description": "Analysis of how well the prompt handles incomplete, incorrect, or ambiguous user inputs."
            }
          }
        },
        "conversationalGuidelines": {
          "type": "object",
          "description": "Analysis of the bot's behavioral instructions, ensuring they align with the conversation's intended tone and structure.",
          "properties": {
            "toneAndPersonality": {
              "type": "string",
              "description": "Evaluation of whether the bot's tone and personality align with the use case (e.g., friendly for customer support, professional for business)."
            },
            "userEngagement": {
              "type": "string",
              "description": "Analysis of whether the bot engages the user effectively without being repetitive or intrusive."
            },
            "errorRecovery": {
              "type": "string",
              "description": "Assessment of how the bot handles misunderstandings, incomplete information, and ambiguous queries."
            },
            "responseBoundaries": {
              "type": "string",
              "description": "Analysis of whether the bot avoids overstepping its boundaries, such as providing legal/medical advice or speculative answers."
            },
            "escalationStrategy": {
              "type": "string",
              "description": "Evaluation of how and when the bot escalates to a human agent or provides alternative solutions."
            }
          }
        },
        "promptChanges": {
          "type": "object",
          "description": "Prompt modifications required based on the user feedback.",
          "properties": {
            "modifications": {
              "type": "array",
              "description": "List of instructions to be modified in a component.",
              "items": {
                "type": "object",
                "properties": {
                  "component": {
                    "type": "string",
                    "description": "Component type where the instruction is to be modified.",
                    "enum": ["AGENT", "KNOWLEDGE_BASE", "CONVERSATION"]
                  },
                  "path": {
                    "type": "string",
                    "description": "Full Path of the field inside the component prompt in which the instruction to be modified."
                  },
                  "current": {
                    "type": "string",
                    "description": "Current instruction text to be replaced."
                  },
                  "updated": {
                    "type": "string",
                    "description": "Updated instruction text."
                  },
                  "reasoning": {
                    "type": "string",
                    "description": "Detailed reasoning for the modification."
                  }
                }
              }
            },
            "deletions": {
              "type": "array",
              "description": "List of instructions to be deleted from a component.",
              "items": {
                "type": "object",
                "properties": {
                  "component": {
                    "type": "string",
                    "description": "Component type where the instruction is to be deleted.",
                    "enum": ["AGENT", "KNOWLEDGE_BASE", "CONVERSATION"]
                  },
                  "path": {
                    "type": "string",
                    "description": "Full Path of the field inside the component prompt from which the instruction needs to be deleted."
                  },
                  "instructionText": {
                    "type": "string",
                    "description": "Current instruction text to be deleted."
                  },
                  "reasoning": {
                    "type": "string",
                    "description": "Detailed reasoning for the deletion."
                  }
                }
              }
            },
            "additions": {
              "type": "array",
              "description": "List of instructions to be added in a component.",
              "items": {
                "type": "object",
                "properties": {
                  "component": {
                    "type": "string",
                    "description": "Component type in which the instruction needs to be added.",
                    "enum": ["AGENT", "KNOWLEDGE_BASE", "CONVERSATION"]
                  },
                  "path": {
                    "type": "string",
                    "description": "Full Path of the field inside the component prompt where the new instructions are to be added."
                  },
                  "preText": {
                    "type": "string",
                    "description": "Instruction text after which the new instruction is to be added."
                  },
                  "newInstruction": {
                    "type": "string",
                    "description": "New instructions to be added."
                  },
                  "reasoning": {
                    "type": "string",
                    "description": "Reasoning for adding the new instructions."
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
              "description": "Full updated agent prompt."
            },
            "KNOWLEDGE_BASE": {
              "type": "string",
              "description": "Full updated knowledge base prompt."
            },
            "CONVERSATION": {
              "type": "string",
              "description": "Full updated conversation prompt."
            }
          }
        },
        "expectedImpact": {
          "type": "string",
          "description": "Detailed impact expectation report of the prompt modifications on the assistant's behavior and what all things should be tested after the modifications."
        }
      }
    }`;
  } else {
    // NLP Bot architecture
    architecturalDetails = `
# IMPORTANT ARCHITECTURAL DETAILS FOR UNDERSTANDING
 - This is an NLP Bot based on a single system prompt.
 - The bot uses a single SYSTEM_PROMPT that defines its behavior, capabilities, and tone.
 - The SYSTEM_PROMPT is initialized at the beginning of the conversation and guides the bot's responses throughout.
 - This bot doesn't use the Agent-Tools architecture and instead relies on a comprehensive system prompt to handle all interactions.
 - The system prompt typically includes instructions for handling various types of queries, personality guidelines, response formats, and contextual boundaries.
 - The bot processes conversation history along with the system prompt to generate appropriate responses for each user input.`;

    // Configured prompts section for NLP Bot
    configuredPromptsSection = `
# CONFIGURED PROMPTS 
## SYSTEM_PROMPT
${configuredPrompts.SYSTEM_PROMPT || 'Not provided'}

## ADDITIONAL_INSTRUCTIONS (if any)
${configuredPrompts.ADDITIONAL_INSTRUCTIONS || 'Not provided'}`;

    // Output schema for NLP Bot
    outputSchema = `
    {
      "type": "object",
      "properties": {
        "gapAnalysis": {
          "type": "string",
          "description": "Detailed analysis of the user feedback, the reason why the assistant didn't behave as expected, and an assessment of the prompt's effectiveness in achieving the conversational goal."
        },
        "promptAnalysis": {
          "type": "object",
          "description": "Analysis of the system prompt fed to the bot, checking for clarity, hallucination risks, logical consistency, and missing elements.",
          "properties": {
            "objectiveClarity": {
              "type": "string",
              "description": "Evaluation of whether the purpose of the prompt is clearly stated and well-defined."
            },
            "requiredDataCollection": {
              "type": "string",
              "description": "Assessment of whether the bot is collecting all necessary details from the user to achieve the conversational goal."
            },
            "logicalFlow": {
              "type": "string",
              "description": "Analysis of the logical coherence of the prompt's instructions and whether they contradict each other."
            },
            "hallucinationRisk": {
              "type": "string",
              "description": "Assessment of whether the bot might generate misleading or fabricated information based on the prompt."
            },
            "errorHandling": {
              "type": "string",
              "description": "Analysis of how well the prompt handles incomplete, incorrect, or ambiguous user inputs."
            }
          }
        },
        "conversationalGuidelines": {
          "type": "object",
          "description": "Analysis of the bot's behavioral instructions, ensuring they align with the conversation's intended tone and structure.",
          "properties": {
            "toneAndPersonality": {
              "type": "string",
              "description": "Evaluation of whether the bot's tone and personality align with the use case (e.g., friendly for customer support, professional for business)."
            },
            "userEngagement": {
              "type": "string",
              "description": "Analysis of whether the bot engages the user effectively without being repetitive or intrusive."
            },
            "errorRecovery": {
              "type": "string",
              "description": "Assessment of how the bot handles misunderstandings, incomplete information, and ambiguous queries."
            },
            "responseBoundaries": {
              "type": "string",
              "description": "Analysis of whether the bot avoids overstepping its boundaries, such as providing legal/medical advice or speculative answers."
            },
            "escalationStrategy": {
              "type": "string",
              "description": "Evaluation of how and when the bot escalates to a human agent or provides alternative solutions."
            }
          }
        },
        "promptChanges": {
          "type": "object",
          "description": "Prompt modifications required based on the user feedback.",
          "properties": {
            "modifications": {
              "type": "array",
              "description": "List of instructions to be modified in the system prompt.",
              "items": {
                "type": "object",
                "properties": {
                  "component": {
                    "type": "string",
                    "description": "Component type where the instruction is to be modified.",
                    "enum": ["SYSTEM_PROMPT", "ADDITIONAL_INSTRUCTIONS"]
                  },
                  "path": {
                    "type": "string",
                    "description": "Section or category inside the system prompt where the instruction to be modified exists."
                  },
                  "current": {
                    "type": "string",
                    "description": "Current instruction text to be replaced."
                  },
                  "updated": {
                    "type": "string",
                    "description": "Updated instruction text."
                  },
                  "reasoning": {
                    "type": "string",
                    "description": "Detailed reasoning for the modification."
                  }
                }
              }
            },
            "deletions": {
              "type": "array",
              "description": "List of instructions to be deleted from the system prompt.",
              "items": {
                "type": "object",
                "properties": {
                  "component": {
                    "type": "string",
                    "description": "Component type where the instruction is to be deleted.",
                    "enum": ["SYSTEM_PROMPT", "ADDITIONAL_INSTRUCTIONS"]
                  },
                  "path": {
                    "type": "string",
                    "description": "Section or category inside the system prompt from which the instruction needs to be deleted."
                  },
                  "instructionText": {
                    "type": "string",
                    "description": "Current instruction text to be deleted."
                  },
                  "reasoning": {
                    "type": "string",
                    "description": "Detailed reasoning for the deletion."
                  }
                }
              }
            },
            "additions": {
              "type": "array",
              "description": "List of instructions to be added to the system prompt.",
              "items": {
                "type": "object",
                "properties": {
                  "component": {
                    "type": "string",
                    "description": "Component type in which the instruction needs to be added.",
                    "enum": ["SYSTEM_PROMPT", "ADDITIONAL_INSTRUCTIONS"]
                  },
                  "path": {
                    "type": "string",
                    "description": "Section or category inside the system prompt where the new instructions are to be added."
                  },
                  "preText": {
                    "type": "string",
                    "description": "Instruction text or section after which the new instruction is to be added."
                  },
                  "newInstruction": {
                    "type": "string",
                    "description": "New instructions to be added."
                  },
                  "reasoning": {
                    "type": "string",
                    "description": "Reasoning for adding the new instructions."
                  }
                }
              }
            }
          }
        },
        "updatedPrompt": {
          "type": "object",
          "description": "Updated prompt in the same format as the configured prompt.",
          "properties": {
            "SYSTEM_PROMPT": {
              "type": "string",
              "description": "Full updated system prompt."
            },
            "ADDITIONAL_INSTRUCTIONS": {
              "type": "string",
              "description": "Updated additional instructions, if applicable."
            }
          }
        },
        "expectedImpact": {
          "type": "string",
          "description": "Detailed impact expectation report of the prompt modifications on the assistant's behavior and what all things should be tested after the modifications."
        }
      }
    }`;
  }

  // Common prompt evaluation guidelines
  const promptEvaluationGuidelines = `
# SYSTEM PROMPT
PURPOSE OF THE PROMPT: Clearly define the objective that the bot should achieve during the conversation.
DATA COLLECTION REQUIREMENTS: Identify what specific details the bot needs to collect from the user (e.g., name, email, preferred date for demo, device type for troubleshooting).
LOGICAL COHERENCE: Ensure the instructions are logically sound and do not contradict each other.
HALLUCINATION RISK: Check if the prompt could cause the bot to fabricate information rather than relying on facts.
ERROR HANDLING: Verify if the prompt includes instructions for handling incomplete or incorrect user input.

# CONVERSATIONAL GUIDELINES:
TONE & BEHAVIOR: Ensure that the bot maintains a conversational tone suited to the use case (e.g., friendly for customer support, professional for business demos).
ENGAGEMENT STRATEGY: Define how the bot should keep the user engaged in the conversation without being repetitive or intrusive.
Error Recovery: Define how the bot should respond if the user provides incomplete or incorrect details.
BOUNDARY SETTING: Define what the bot should avoid (e.g., not making medical or legal claims, avoiding speculative responses).
ESCALATION STRATEGY: If applicable, specify when and how the bot should transfer the conversation to a human agent.

***IMPORTANT NOTES***: It is encouraged that the model to articulate its reasoning process step-by-step when identifying issues.\n The model before generating the responses should generate multiple critiques or alternative solutions and verify them against each other and then should output the best one (Without reflecting them in the responses. DO CARRY OUT THE SELF CRITIQUE STEP.).`;

  // Combine all sections based on bot type
  return `${introduction}
${architecturalDetails}
${promptEvaluationGuidelines}
# CONVERSATION HISTORY TILL THAT MESSAGE
${JSON.stringify(conversationHistory, null, 2)}

# TARGETED BOT RESPONSE
${JSON.stringify(targetBotResponse, null, 2)}

# USER FEEDBACK ON THE TARGET BOT RESPONSE
${JSON.stringify(userFeedback, null, 2)}

# IMPORTANT LOGS AND REASONING FOR THE TARGETED USER MESSAGE PROCESSING
${JSON.stringify(executionContext || {}, null, 2)}
${configuredPromptsSection}
${knowledgeBaseUrls ? `
# KNOWLEDGE BASE URLS
${JSON.stringify(knowledgeBaseUrls, null, 2)}` : ''}

# OUTPUT
- You must respond with the prompt modifications required based on the user feedback.
- Your response should be in valid JSON format matching the schema:
${outputSchema}`;
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