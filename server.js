
"use strict";

// ==================================================
// CONFIGURAÇÕES — EDITE AQUI
// ==================================================

const http = require("node:http");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 10000;

// Sua chave real: https://aistudio.google.com/apikey
const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY || "AQ.Ab8RN6I1G0ZfrwPBidU77n3ney4HM0dQSf9NpCWvl4tGpPTUIw";

// Senha compartilhada entre Roblox e servidor
const BRIDGE_TOKEN =
    process.env.BRIDGE_TOKEN || "14119206@Hack4444";

// Modelo Gemini
const MODEL =
    process.env.GEMINI_MODEL || "gemini-3.5-flash";

// Limites de segurança
const MAX_PARTS = 60;
const MAX_COMMAND_LENGTH = 300;
const MAX_BODY_LENGTH = 5000;
const MAX_REQUESTS_PER_MINUTE = 8;

// ==================================================
// VERIFICAÇÃO DA CONFIGURAÇÃO
// ==================================================

if (
    !GEMINI_API_KEY ||
    GEMINI_API_KEY === "AQ.Ab8RN6I1G0ZfrwPBidU77n3ney4HM0dQSf9NpCWvl4tGpPTUIw" ||
    !BRIDGE_TOKEN
) {
    console.error("Configure GEMINI_API_KEY e BRIDGE_TOKEN.");
    process.exit(1);
}

// ==================================================
// CORES E MATERIAIS PERMITIDOS
// ==================================================

const COLORS = [
    "White", "Black", "Gray", "Brown", "Tan",
    "Red", "Orange", "Yellow", "Green", "Blue",
    "Purple", "Glass"
];

const MATERIALS = [
    "Wood", "Concrete", "Brick", "Metal",
    "Glass", "Plastic", "Slate", "Cobblestone"
];

const rateLimits = new Map();

// ==================================================
// RESPOSTAS HTTP
// ==================================================

function send(res, status, data) {
    if (res.writableEnded) return;

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });

    res.end(JSON.stringify(data));
}

// ==================================================
// AUTENTICAÇÃO
// ==================================================

function authorized(req) {
    const token = req.headers["x-bridge-token"];

    if (
        typeof token !== "string" ||
        token.length !== BRIDGE_TOKEN.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        Buffer.from(token),
        Buffer.from(BRIDGE_TOKEN)
    );
}

// ==================================================
// LIMITE DE REQUISIÇÕES
// ==================================================

function allowedRequest(req) {
    const ip = req.socket.remoteAddress || "unknown";
    const now = Date.now();

    const previous = rateLimits.get(ip) || [];
    const recent = previous.filter(
        time => now - time < 60_000
    );

    if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
        return false;
    }

    recent.push(now);
    rateLimits.set(ip, recent);

    return true;
}

// ==================================================
// LEITURA DO JSON
// ==================================================

async function readBody(req) {
    let raw = "";

    for await (const chunk of req) {
        raw += chunk.toString("utf8");

        if (Buffer.byteLength(raw, "utf8") > MAX_BODY_LENGTH) {
            throw new Error("Pedido muito grande.");
        }
    }

    return JSON.parse(raw);
}

// ==================================================
// VALIDAR PLANO DE CONSTRUÇÃO
// ==================================================

function validatePlan(plan) {
    if (
        !plan ||
        typeof plan.reply !== "string" ||
        !Array.isArray(plan.parts) ||
        plan.parts.length > MAX_PARTS
    ) {
        throw new Error("Plano inválido.");
    }

    const parts = plan.parts.map(part => {
        if (
            !part ||
            !Array.isArray(part.size) ||
            part.size.length !== 3 ||
            !Array.isArray(part.offset) ||
            part.offset.length !== 3
        ) {
            throw new Error("Formato de peça inválido.");
        }

        const validSize = part.size.every(
            n => typeof n === "number" &&
                Number.isFinite(n) &&
                n >= 1 && n <= 30
        );

        const validOffset = part.offset.every(
            n => typeof n === "number" &&
                Number.isFinite(n) &&
                n >= -45 && n <= 45
        );

        if (
            !validSize ||
            !validOffset ||
            !COLORS.includes(part.color) ||
            !MATERIALS.includes(part.material)
        ) {
            throw new Error("Peça fora dos limites permitidos.");
        }

        return {
            size: part.size,
            offset: part.offset,
            color: part.color,
            material: part.material
        };
    });

    return {
        reply: plan.reply.slice(0, 350),
        parts
    };
}

// ==================================================
// CONSULTAR GEMINI
// ==================================================

async function askGemini(command) {
    const prompt = `
Você é um arquiteto de construções para um jogo Roblox.

O jogador pediu:
${command}

Crie uma construção coerente usando no máximo ${MAX_PARTS} blocos.

Responda somente com JSON no formato:
{
  "reply": "mensagem curta em português",
  "parts": [
    {
      "size": [10, 1, 10],
      "offset": [0, 0, 0],
      "color": "Brown",
      "material": "Wood"
    }
  ]
}

REGRAS:
- Cada peça é um bloco retangular.
- Size são dimensões em studs.
- Offset é relativo à origem da construção.
- A base fica no nível do chão.
- Os blocos acima do chão devem ter offset Y positivo.
- Dimensões entre 1 e 30.
- Cada coordenada offset entre -45 e 45.
- Máximo de ${MAX_PARTS} peças.
- Cores permitidas: ${COLORS.join(", ")}.
- Materiais permitidos: ${MATERIALS.join(", ")}.
- Não crie código executável ou scripts.
- Se não for um pedido de construção, retorne parts vazio.
`;

    const url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(MODEL) +
        ":generateContent";

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
            contents: [
                {
                    role: "user",
                    parts: [{ text: prompt }]
                }
            ],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        reply: {
                            type: "STRING"
                        },
                        parts: {
                            type: "ARRAY",
                            maxItems: MAX_PARTS,
                            items: {
                                type: "OBJECT",
                                properties: {
                                    size: {
                                        type: "ARRAY",
                                        minItems: 3,
                                        maxItems: 3,
                                        items: { type: "NUMBER" }
                                    },
                                    offset: {
                                        type: "ARRAY",
                                        minItems: 3,
                                        maxItems: 3,
                                        items: { type: "NUMBER" }
                                    },
                                    color: {
                                        type: "STRING",
                                        enum: COLORS
                                    },
                                    material: {
                                        type: "STRING",
                                        enum: MATERIALS
                                    }
                                },
                                required: [
                                    "size",
                                    "offset",
                                    "color",
                                    "material"
                                ],
                                propertyOrdering: [
                                    "size",
                                    "offset",
                                    "color",
                                    "material"
                                ]
                            }
                        }
                    },
                    required: ["reply", "parts"],
                    propertyOrdering: ["reply", "parts"]
                }
            }
        }),
        signal: AbortSignal.timeout(45_000)
    });

    const data = await response.json();

    if (!response.ok) {
        console.error("Gemini retornou HTTP", response.status);
        throw new Error("Erro ao consultar Gemini.");
    }

    const text = data.candidates?.[0]?.content?.parts
        ?.map(item => item.text || "")
        .join("");

    if (!text) {
        throw new Error("O Gemini não retornou um plano.");
    }

    return validatePlan(JSON.parse(text));
}

// ==================================================
// SERVIDOR HTTP
// ==================================================

const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, {
            ok: true,
            service: "Roblox Gemini NPC Builder"
        });
    }

    if (req.method !== "POST" || req.url !== "/build") {
        return send(res, 404, {
            error: "Rota não encontrada."
        });
    }

    if (!authorized(req)) {
        return send(res, 401, {
            error: "Não autorizado."
        });
    }

    if (!allowedRequest(req)) {
        return send(res, 429, {
            error: "Muitos pedidos. Aguarde um minuto."
        });
    }

    try {
        const body = await readBody(req);

        if (
            typeof body.command !== "string" ||
            body.command.trim().length < 2 ||
            body.command.length > MAX_COMMAND_LENGTH
        ) {
            return send(res, 400, {
                error: "Pedido deve ter de 2 a 300 caracteres."
            });
        }

        const plan = await askGemini(body.command.trim());

        return send(res, 200, plan);
    } catch (error) {
        console.error("Falha:", error.message);

        return send(res, 502, {
            error: "Não foi possível gerar a construção."
        });
    }
});

// ==================================================
// INICIAR
// ==================================================

server.listen(PORT, "0.0.0.0", () => {
    console.log("Roblox Gemini NPC Builder iniciado.");
    console.log("Porta:", PORT);
});
