import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export const db = {
  query: async (sql, params) => {
    const [result] = await pool.execute(sql, params);
    // Return result directly (works for both SELECT and INSERT/UPDATE)
    return result;
  },
  getConnection: async () => {
    const connection = await pool.getConnection();
    
    // Add custom query method to the connection
    connection.query = async (sql, params) => {
      const [result] = await connection.execute(sql, params);
      return result;
    };
    
    return connection;
  },
  pool,
};
