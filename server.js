require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 5000;

// Rota para fazer o scraping
app.get("/scrape", async (req, res) => {
  try {
    console.log("Iniciando scraping...");
    const url = "https://g1.globo.com";
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    console.log("HTML recebido!");
    const $ = cheerio.load(data);
    let articles = [];

    $("p").each((i, el) => {
      let title = $(el).text().trim();
      let summary = $(el).closest("article").find("a").first().text().trim();
      let link = $(el).closest("a").attr("href") || "";

      if (link.startsWith("/")) {
        link = `https://g1.globo.com${link}`;
      }

      if (title && link) {
        articles.push({ title, summary, link });
      }
    });

    console.log("Scraping concluído:", articles);
    res.json(articles);
  } catch (error) {
    console.error("Erro ao coletar os dados:", error);
    res.status(500).json({ message: "Erro ao coletar os dados" });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
