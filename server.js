
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

if (!GEMINI_API_KEY || !BRIDGE_TOKEN) {
    console.error("Configure GEMINI_API_KEY e BRIDGE_TOKEN.");
    process.exit(1);
}

const colors = [
    "White", "Black", "Gray", "Brown", "Tan",
    "Red", "Orange", "Yellow", "Green", "Blue",
    "Purple", "Glass"
];

const materials = [
    "Wood", "Concrete", "Brick", "Metal",
    "Glass", "Plastic", "Slate", "Cobblestone"
];

function send(res, status, data) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(data));
}

function validatePlan(plan) {
    if (!plan || typeof plan.reply !== "string" ||
        !Array.isArray(plan.parts) || plan.parts.length > 60) {
        throw new Error("Plano inválido.");
    }

    for (const p of plan.parts) {
        if (!Array.isArray(p.size) || p.size.length !== 3 ||
            !Array.isArray(p.offset) || p.offset.length !== 3 ||
            !p.size.every(n => Number.isFinite(n) && n >= 1 && n <= 30) ||
            !p.offset.every(n => Number.isFinite(n) && n >= -45 && n <= 45) ||
            !colors.includes(p.color) ||
            !materials.includes(p.material)) {
            throw new Error("Peça inválida.");
        }
    }

    return {
        reply: plan.reply.slice(0, 350),
        parts: plan.parts
    };
}

const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, { ok: true });
    }

    if (req.method !== "POST" || req.url !== "/build") {
        return send(res, 404, { error: "Not found" });
    }

    const token = req.headers["x-bridge-token"];

    if (typeof token !== "string" ||
        token.length !== BRIDGE_TOKEN.length ||
        !crypto.timingSafeEqual(
            Buffer.from(token), Buffer.from(BRIDGE_TOKEN)
        )) {
        return send(res, 401, { error: "Unauthorized" });
    }

    try {
        let raw = "";

        for await (const chunk of req) {
            raw += chunk.toString();
            if (raw.length > 5000) {
                return send(res, 413, { error: "Request too large" });
            }
        }

        const body = JSON.parse(raw);

        if (typeof body.command !== "string" ||
            body.command.length < 2 || body.command.length > 300) {
            return send(res, 400, { error: "Invalid command" });
        }

        const prompt = `
Você é um arquiteto de construções para Roblox.
Crie uma estrutura usando no máximo 60 blocos.
Responda apenas JSON neste formato:
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
Size são dimensões em studs. Offset é relativo à origem
da construção. Y=0 corresponde ao chão; use offsets positivos
para colocar peças acima do chão.
Cada dimensão deve ficar entre 1 e 30.
Cada offset deve ficar entre -45 e 45.
Cores permitidas: ${colors.join(", ")}.
Materiais permitidos: ${materials.join(", ")}.
Não crie scripts nem código executável.
Pedido do jogador: ${body.command}
`;

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": GEMINI_API_KEY
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: "OBJECT",
                            properties: {
                                reply: { type: "STRING" },
                                parts: {
                                    type: "ARRAY",
                                    maxItems: 60,
                                    items: {
                                        type: "OBJECT",
                                        properties: {
                                            size: {
                                                type: "ARRAY",
                                                items: { type: "NUMBER" }
                                            },
                                            offset: {
                                                type: "ARRAY",
                                                items: { type: "NUMBER" }
                                            },
                                            color: {
                                                type: "STRING",
                                                enum: colors
                                            },
                                            material: {
                                                type: "STRING",
                                                enum: materials
                                            }
                                        },
                                        required: [
                                            "size", "offset", "color", "material"
                                        ],
                                        propertyOrdering: [
                                            "size", "offset", "color", "material"
                                        ]
                                    }
                                }
                            },
                            required: ["reply", "parts"],
                            propertyOrdering: ["reply", "parts"]
                        }
                    }
                }),
                signal: AbortSignal.timeout(45000)
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error("Gemini HTTP:", response.status);
            return send(res, 502, { error: "Gemini request failed" });
        }

        const text = data.candidates?.[0]?.content?.parts
            ?.map(p => p.text || "").join("");

        if (!text) {
            return send(res, 502, { error: "Empty Gemini response" });
        }

        const plan = validatePlan(JSON.parse(text));
        return send(res, 200, plan);

    } catch (error) {
        console.error("Request error:", error.message);
        return send(res, 500, { error: "Could not process request" });
    }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("Gemini NPC server ready on port " + PORT);
});
