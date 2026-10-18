
const http = require("node:http");

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const COLORS = [
  "Really red", "Bright red", "Bright blue", "Really blue",
  "Bright green", "Lime green", "New Yeller", "Bright yellow",
  "White", "Black", "Dark stone grey", "Medium stone grey",
  "Brown", "Reddish brown", "Orange", "Bright orange",
  "Hot pink", "Pink", "Royal purple", "Institutional white",
  "Sand red", "Sand yellow", "Earth green"
];

const MATERIALS = [
  "Plastic", "Wood", "WoodPlanks", "Concrete", "Brick",
  "Cobblestone", "Slate", "Metal", "DiamondPlate",
  "Grass", "Sand", "Rock", "Marble", "Granite"
];

const responseSchema = {
  type: "OBJECT",
  properties: {
    reply: {
      type: "STRING",
      description: "Resposta curta em português para o jogador."
    },
    parts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          size: {
            type: "OBJECT",
            properties: {
              x: { type: "NUMBER" },
              y: { type: "NUMBER" },
              z: { type: "NUMBER" }
            },
            required: ["x", "y", "z"]
          },
          offset: {
            type: "OBJECT",
            properties: {
              x: { type: "NUMBER" },
              y: { type: "NUMBER" },
              z: { type: "NUMBER" }
            },
            required: ["x", "y", "z"]
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
        required: ["size", "offset", "color", "material"]
      }
    }
  },
  required: ["reply", "parts"]
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const send = (status, data) => {
    res.writeHead(status);
    res.end(JSON.stringify(data));
  };

  if (req.method === "GET" && req.url === "/health") {
    return send(200, {
      ok: true,
      service: "Roblox Gemini NPC Builder"
    });
  }

  if (req.method !== "POST" || req.url !== "/build") {
    return send(404, { error: "Rota não encontrada." });
  }

  if (!GEMINI_API_KEY || !BRIDGE_TOKEN) {
    return send(500, {
      error: "Configure GEMINI_API_KEY e BRIDGE_TOKEN no servidor."
    });
  }

  if (req.headers["x-bridge-token"] !== BRIDGE_TOKEN) {
    return send(401, { error: "Acesso não autorizado." });
  }

  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 10000) {
        return send(413, { error: "Requisição muito grande." });
      }
    }

    const data = JSON.parse(body);
    const command = String(data.command || "").trim();

    if (!command || command.length > 300) {
      return send(400, {
        error: "O comando deve ter entre 1 e 300 caracteres."
      });
    }

    const prompt = `
Você é um construtor de mapas para Roblox.
O jogador pediu: "${command}"

Crie uma construção usando somente peças retangulares (Parts).
Responda em português, com uma mensagem curta.
Gere até 60 peças para construir o que o jogador pediu.
As peças são posicionadas relativamente ao centro da construção.
O eixo Y é a altura. O chão fica aproximadamente em Y=0.
Use tamanhos de 1 a 30 em cada eixo.
Use offsets entre -45 e 45 em cada eixo.
Use somente estas cores: ${COLORS.join(", ")}.
Use somente estes materiais: ${MATERIALS.join(", ")}.
Para uma casa, inclua chão, paredes e telhado quando possível.
Para pedidos que não sejam construções, explique que você pode construir objetos.
Retorne JSON seguindo o esquema solicitado.
Não inclua scripts, código executável ou conteúdo fora da construção.
`;

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    const aiResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0.4
        }
      }),
      signal: AbortSignal.timeout(45000)
    });

    const result = await aiResponse.json();

    if (!aiResponse.ok) {
      console.error("Erro Gemini:", aiResponse.status, result);
      return send(502, {
        error: "O Gemini não conseguiu processar o comando."
      });
    }

    const text = result.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("");

    if (!text) {
      return send(502, { error: "O Gemini retornou uma resposta vazia." });
    }

    const output = JSON.parse(text);

    if (!Array.isArray(output.parts)) {
      return send(502, { error: "Formato de construção inválido." });
    }

    output.parts = output.parts.slice(0, 60).map(part => {
      const clamp = (value, min, max, fallback) => {
        const n = Number(value);
        return Number.isFinite(n)
          ? Math.max(min, Math.min(max, n))
          : fallback;
      };

      return {
        size: {
          x: clamp(part.size?.x, 1, 30, 4),
          y: clamp(part.size?.y, 1, 30, 4),
          z: clamp(part.size?.z, 1, 30, 4)
        },
        offset: {
          x: clamp(part.offset?.x, -45, 45, 0),
          y: clamp(part.offset?.y, -45, 45, 0),
          z: clamp(part.offset?.z, -45, 45, 0)
        },
        color: COLORS.includes(part.color) ? part.color : "White",
        material: MATERIALS.includes(part.material)
          ? part.material
          : "Plastic"
      };
    });

    output.reply = String(output.reply || "Construção pronta.")
      .slice(0, 300);

    return send(200, output);

  } catch (error) {
    console.error("Erro no servidor:", error.message);
    return send(500, {
      error: "Erro interno ao processar o comando."
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});
