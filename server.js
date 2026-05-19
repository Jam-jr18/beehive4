/**
 * BEEHIVE RESTOBAR - PROD BACKEND SERVER
 * Node.js + Express + MySQL
 */

import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Fix __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 5000;

// ======================================
// MIDDLEWARE
// ======================================

app.use(cors());

app.use(bodyParser.json({
  limit: '50mb'
}));

app.use(express.static(path.join(__dirname, 'dist')));

// ======================================
// MYSQL CONNECTION
// ======================================

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  ssl: {
    rejectUnauthorized: false
  }
});

// ======================================
// ASYNC HANDLER
// ======================================

const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ======================================
// API ROUTES
// ======================================

// GET INITIAL DATA
app.get('/api/init', asyncHandler(async (req, res) => {

  const [orders] = await pool.query(
    'SELECT * FROM orders ORDER BY timestamp DESC'
  );

  const [menu] = await pool.query(
    'SELECT * FROM menu'
  );

  const [categories] = await pool.query(
    'SELECT name FROM categories'
  );

  const [tables] = await pool.query(
    'SELECT * FROM tables'
  );

  const [settings] = await pool.query(
    'SELECT * FROM settings LIMIT 1'
  );

  res.json({
    orders: orders.map(o => {

      let parsedItems = [];

      try {
        parsedItems =
          typeof o.items === 'string'
            ? JSON.parse(o.items)
            : o.items;
      } catch (err) {
        console.error('JSON Parse Error:', err);
      }

      return {
        ...o,
        items: parsedItems
      };

    }),

    menu,

    categories: categories.map(c => c.name),

    tables: tables.map(t => ({
      ...t,
      isOccupied: !!t.isOccupied
    })),

    paymentConfig: settings[0] || {}
  });

}));

// CREATE ORDER
app.post('/api/orders', asyncHandler(async (req, res) => {

  const {
    customerName,
    tableNumber,
    items,
    total,
    orderType,
    paymentMethod,
    paymentReference,
    paymentSender
  } = req.body;

  const id =
    'ORD-' +
    Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();

  const timestamp = Date.now();

  let itemsJson = '[]';

  try {

    itemsJson =
      typeof items === 'string'
        ? items
        : JSON.stringify(items);

  } catch (err) {

    return res.status(400).json({
      success: false,
      message: 'Invalid items format'
    });

  }

  await pool.execute(`
    INSERT INTO orders (
      id,
      customerName,
      tableNumber,
      items,
      total,
      orderType,
      paymentMethod,
      paymentReference,
      paymentSender,
      timestamp,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    customerName,
    tableNumber || null,
    itemsJson,
    total,
    orderType,
    paymentMethod,
    paymentReference || null,
    paymentSender || null,
    timestamp,
    'Pending'
  ]);

  // OCCUPY TABLE
  if (orderType === 'Dine-in' && tableNumber) {

    await pool.execute(
      'UPDATE tables SET isOccupied = 1 WHERE id = ?',
      [tableNumber]
    );

  }

  res.status(201).json({
    success: true,
    id,
    status: 'Pending'
  });

}));

// UPDATE ORDER STATUS
app.patch('/api/orders/:id/status', asyncHandler(async (req, res) => {

  const { id } = req.params;
  const { status } = req.body;

  const [rows] = await pool.query(
    'SELECT tableNumber FROM orders WHERE id = ?',
    [id]
  );

  const order = rows[0];

  await pool.execute(
    'UPDATE orders SET status = ? WHERE id = ?',
    [status, id]
  );

  // FREE TABLE
  if (
    (status === 'Completed' ||
      status === 'Cancelled') &&
    order?.tableNumber
  ) {

    await pool.execute(
      'UPDATE tables SET isOccupied = 0 WHERE id = ?',
      [order.tableNumber]
    );

  }

  res.json({
    success: true
  });

}));

// GET MENU
app.get('/api/menu', asyncHandler(async (req, res) => {

  const [rows] = await pool.query(
    'SELECT * FROM menu'
  );

  res.json(rows);

}));

// SAVE / UPDATE MENU ITEM
app.post('/api/menu', asyncHandler(async (req, res) => {

  const {
    id,
    name,
    price,
    category,
    description,
    image,
    accentColor
  } = req.body;

  const [exists] = await pool.query(
    'SELECT id FROM menu WHERE id = ?',
    [id]
  );

  if (exists.length > 0) {

    await pool.execute(`
      UPDATE menu
      SET
        name = ?,
        price = ?,
        category = ?,
        description = ?,
        image = ?,
        accentColor = ?
      WHERE id = ?
    `, [
      name,
      price,
      category,
      description,
      image,
      accentColor,
      id
    ]);

  } else {

    await pool.execute(`
      INSERT INTO menu (
        id,
        name,
        price,
        category,
        description,
        image,
        accentColor
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      name,
      price,
      category,
      description,
      image,
      accentColor
    ]);

  }

  res.json({
    success: true
  });

}));

// DELETE MENU ITEM
app.delete('/api/menu/:id', asyncHandler(async (req, res) => {

  const { id } = req.params;

  await pool.execute(
    'DELETE FROM menu WHERE id = ?',
    [id]
  );

  res.status(204).send();

}));

// ADD CATEGORY
app.post('/api/categories', asyncHandler(async (req, res) => {

  const { category } = req.body;

  await pool.execute(
    'INSERT IGNORE INTO categories (name) VALUES (?)',
    [category]
  );

  res.json({
    success: true
  });

}));

// SAVE SETTINGS
app.post('/api/settings', asyncHandler(async (req, res) => {

  const {
    eWalletNumber,
    qrCodeUrl,
    staffPin,
    adminPin
  } = req.body;

  await pool.execute('DELETE FROM settings');

  await pool.execute(`
    INSERT INTO settings (
      eWalletNumber,
      qrCodeUrl,
      staffPin,
      adminPin
    )
    VALUES (?, ?, ?, ?)
  `, [
    eWalletNumber,
    qrCodeUrl,
    staffPin,
    adminPin
  ]);

  res.json({
    success: true
  });

}));

// TOGGLE TABLE
app.patch('/api/tables/:id', asyncHandler(async (req, res) => {

  const { id } = req.params;
  const { isOccupied } = req.body;

  await pool.execute(
    'UPDATE tables SET isOccupied = ? WHERE id = ?',
    [isOccupied ? 1 : 0, id]
  );

  res.json({
    success: true
  });

}));

// ======================================
// FRONTEND FALLBACK
// ======================================

app.use((req, res) => {

  res.sendFile(
    path.join(__dirname, 'dist', 'index.html')
  );

});

// ======================================
// ERROR HANDLER
// ======================================

app.use((err, req, res, next) => {

  console.error(err);

  res.status(500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });

});

// ======================================
// START SERVER
// ======================================

app.listen(PORT, () => {

  console.log(`🚀 Server running on port ${PORT}`);

});
