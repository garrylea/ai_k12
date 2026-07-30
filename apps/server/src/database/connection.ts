import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;

export function createPool(): mysql.Pool {
  if (pool) return pool;
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'ai_k12',
    password: process.env.DB_PASS || 'ai_k12',
    database: process.env.DB_NAME || 'ai_k12',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
  return pool;
}

export function getPool(): mysql.Pool {
  if (!pool) throw new Error('Database pool not initialized. Call createPool() first.');
  return pool;
}
