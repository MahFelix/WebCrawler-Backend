require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// Configuração do PostgreSQL com fallback
const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "news_scraper",
  password: process.env.DB_PASSWORD || "postgres",
  port: parseInt(process.env.DB_PORT) || 5432,
  // Configurações adicionais para melhor performance
  max: 20, // Número máximo de clientes no pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Verificação de conexão com o banco de dados
pool.on('error', (err) => {
  console.error('Erro inesperado no cliente do PostgreSQL:', err);
  process.exit(-1);
});

// Criar tabela se não existir com índices para performance
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS articles (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT,
        link TEXT UNIQUE NOT NULL,
        source VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_articles_link ON articles(link);
      CREATE INDEX IF NOT EXISTS idx_articles_created_at ON articles(created_at);
    `);
    console.log("Banco de dados inicializado com sucesso");
  } catch (err) {
    console.error("Erro ao inicializar o banco de dados:", err);
    throw err;
  } finally {
    client.release();
  }
}

// Configuração do diretório de armazenamento
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Função aprimorada para salvar em arquivo com rotação
function saveToFile(data) {
  try {
    const dateStr = new Date().toISOString().split('T')[0];
    const filePath = path.join(DATA_DIR, `articles_${dateStr}.json`);
    
    // Rotação de arquivos - mantém apenas os últimos 7 dias
    fs.readdirSync(DATA_DIR)
      .filter(file => file.startsWith('articles_') && file.endsWith('.json'))
      .sort()
      .slice(0, -7)
      .forEach(oldFile => fs.unlinkSync(path.join(DATA_DIR, oldFile)));
    
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`Dados salvos em ${filePath}`);
    return true;
  } catch (err) {
    console.error("Erro ao salvar em arquivo:", err);
    return false;
  }
}

// Função otimizada para salvar no banco de dados em lote
async function saveToDB(articles) {
  if (!articles.length) return true;
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Usando UNNEST para inserção em lote mais eficiente
    const values = articles.flatMap(article => [
      article.title,
      article.summary || "Sem resumo disponível",
      article.link,
      article.source || "G1"
    ]);
    
    const placeholders = articles.map((_, i) => 
      `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4})`).join(',');
    
    await client.query(
      `INSERT INTO articles (title, summary, link, source)
       VALUES ${placeholders}
       ON CONFLICT (link) 
       DO UPDATE SET 
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         updated_at = NOW()`,
      values
    );
    
    await client.query("COMMIT");
    console.log(`Dados salvos no banco: ${articles.length} artigos`);
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro ao salvar no banco:", err);
    return false;
  } finally {
    client.release();
  }
}

// Middleware de logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Rota de saúde da aplicação
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    db_connected: !!pool,
    storage: {
      directory: DATA_DIR,
      exists: fs.existsSync(DATA_DIR),
      writable: (() => {
        try {
          fs.accessSync(DATA_DIR, fs.constants.W_OK);
          return true;
        } catch {
          return false;
        }
      })()
    }
  });
});

// Rota aprimorada para scraping com cache e validação
app.get("/scrape", async (req, res) => {
  const startTime = Date.now();
  let fromCache = false;
  
  try {
    console.log("Iniciando scraping do G1...");
    const url = "https://g1.globo.com";
    
    // Verifica cache recente (últimos 5 minutos)
    const cacheResult = await pool.query(
      `SELECT title, summary, link 
       FROM articles 
       WHERE created_at > NOW() - INTERVAL '5 minutes'
       ORDER BY created_at DESC LIMIT 50`
    );
    
    if (cacheResult.rows.length >= 10) { // Limite arbitrário para considerar cache válido
      console.log("Retornando dados do cache recente");
      fromCache = true;
      return res.json({
        success: true,
        fromCache: true,
        count: cacheResult.rows.length,
        articles: cacheResult.rows,
        timestamp: new Date().toISOString(),
        performance: `${Date.now() - startTime}ms`
      });
    }
    
    // Se não tem cache válido, faz scraping
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      },
      timeout: 10000
    });

    const $ = cheerio.load(data);
    const articles = [];

    // Seletores atualizados para o G1
    $(".feed-post").each((i, el) => {
      try {
        const title = $(el).find(".feed-post-link").text().trim();
        const summary = $(el).find(".feed-post-body-resumo").text().trim();
        let link = $(el).find("a").attr("href") || "";

        if (link && !link.startsWith("http")) {
          link = `https://g1.globo.com${link}`;
        }

        if (title && link) {
          articles.push({ 
            title, 
            summary: summary || "Sem resumo disponível", 
            link,
            source: "G1"
          });
        }
      } catch (err) {
        console.error("Erro ao processar elemento:", err);
      }
    });

    // Filtra resultados únicos e válidos
    const uniqueArticles = articles
      .filter(article => article.link && article.title)
      .filter((v, i, a) => a.findIndex(t => t.link === v.link) === i);

    console.log(`Encontrados ${uniqueArticles.length} artigos válidos`);

    // Armazena os dados (paralelamente)
    const [dbSuccess, fileSuccess] = await Promise.all([
      saveToDB(uniqueArticles),
      saveToFile(uniqueArticles)
    ]);

    if (!dbSuccess || !fileSuccess) {
      console.warn("Houve problemas ao salvar alguns dados");
    }

    res.json({
      success: true,
      fromCache: false,
      count: uniqueArticles.length,
      articles: uniqueArticles,
      timestamp: new Date().toISOString(),
      performance: `${Date.now() - startTime}ms`,
      storage: {
        database: dbSuccess,
        file: fileSuccess
      }
    });
  } catch (error) {
    console.error("Erro no scraping:", error);
    
    // Tenta retornar dados do banco como fallback
    try {
      const dbRes = await pool.query(
        "SELECT title, summary, link FROM articles ORDER BY created_at DESC LIMIT 50"
      );
      
      res.json({
        success: dbRes.rows.length > 0,
        fromCache: true,
        message: dbRes.rows.length > 0 
          ? "Dados podem estar desatualizados" 
          : "Nenhum dado disponível",
        count: dbRes.rows.length,
        articles: dbRes.rows,
        timestamp: new Date().toISOString(),
        error: dbRes.rows.length > 0 ? null : error.message
      });
    } catch (dbError) {
      console.error("Erro ao buscar do banco:", dbError);
      res.status(500).json({ 
        success: false,
        message: "Erro ao coletar os dados",
        error: error.message,
        details: process.env.NODE_ENV === "development" ? error.stack : undefined
      });
    }
  }
});

// Rota para buscar dados históricos com paginação e filtros
app.get("/articles", async (req, res) => {
  try {
    const { 
      limit = 50, 
      offset = 0,
      search,
      fromDate,
      toDate
    } = req.query;
    
    let query = "SELECT title, summary, link, created_at FROM articles";
    const params = [];
    const conditions = [];
    
    // Filtros
    if (search) {
      conditions.push(`(title ILIKE $${params.length + 1} OR summary ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }
    
    if (fromDate) {
      conditions.push(`created_at >= $${params.length + 1}`);
      params.push(new Date(fromDate));
    }
    
    if (toDate) {
      conditions.push(`created_at <= $${params.length + 1}`);
      params.push(new Date(toDate));
    }
    
    if (conditions.length) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));
    
    // Contagem total para paginação
    const countQuery = query.replace(
      /SELECT .*? FROM/, 
      "SELECT COUNT(*) FROM"
    ).replace(/LIMIT \$\d+ OFFSET \$\d+/, "");
    
    const [result, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, params.slice(0, -2))
    ]);
    
    res.json({
      success: true,
      count: result.rows.length,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
      articles: result.rows
    });
  } catch (error) {
    console.error("Erro ao buscar artigos:", error);
    res.status(500).json({ 
      success: false,
      message: "Erro ao buscar artigos",
      error: error.message
    });
  }
});

// Tratamento de erros global
app.use((err, req, res, next) => {
  console.error("Erro não tratado:", err);
  res.status(500).json({
    success: false,
    message: "Erro interno no servidor",
    error: err.message
  });
});

// Inicialização segura
async function startServer() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`Servidor rodando na porta ${PORT}`);
      console.log(`Modo: ${process.env.NODE_ENV || "development"}`);
      console.log(`Banco de dados: ${pool.options.database}@${pool.options.host}`);
      console.log(`Armazenamento: ${DATA_DIR}`);
    });
  } catch (err) {
    console.error("Falha na inicialização:", err);
    process.exit(1);
  }
}

startServer();

// Encerramento gracioso
process.on('SIGTERM', async () => {
  console.log("Encerrando servidor...");
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log("Servidor interrompido");
  await pool.end();
  process.exit(0);
});