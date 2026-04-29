const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuração do TiDB
const pool = mysql.createPool({
    host: process.env.TIDB_HOST,
    port: parseInt(process.env.TIDB_PORT) || 4000,
    user: process.env.TIDB_USER,
    password: process.env.TIDB_PASSWORD,
    database: process.env.TIDB_DATABASE || 'cantina_db',
    ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const JWT_SECRET = process.env.JWT_SECRET || 'cantina_secret_key_2024_igreja';

// Middleware de autenticação
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido' });
        req.user = user;
        next();
    });
};

// Rotas de Autenticação
app.post('/api/auth/store/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [rows] = await pool.execute('SELECT * FROM stores WHERE email = ?', [email]);
        
        if (rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas' });
        
        const store = rows[0];
        const validPassword = await bcrypt.compare(password, store.password);
        
        if (!validPassword) return res.status(401).json({ error: 'Credenciais inválidas' });
        
        const token = jwt.sign({ id: store.id, type: 'store', name: store.name }, JWT_SECRET);
        res.json({ token, store: { id: store.id, name: store.name, email: store.email } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro no login' });
    }
});

app.post('/api/auth/attendant/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [rows] = await pool.execute(
            'SELECT a.*, s.name as store_name, s.id as store_id FROM attendants a JOIN stores s ON a.store_id = s.id WHERE a.email = ?',
            [email]
        );
        
        if (rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas' });
        
        const attendant = rows[0];
        const validPassword = await bcrypt.compare(password, attendant.password);
        
        if (!validPassword) return res.status(401).json({ error: 'Credenciais inválidas' });
        
        const token = jwt.sign({ id: attendant.id, type: 'attendant', storeId: attendant.store_id }, JWT_SECRET);
        res.json({ token, attendant: { id: attendant.id, name: attendant.name, store_name: attendant.store_name } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro no login' });
    }
});

// Rotas de Produtos
app.get('/api/products/:storeId', async (req, res) => {
    try {
        const [products] = await pool.execute(
            'SELECT * FROM products WHERE store_id = ? AND is_available = TRUE ORDER BY category, name',
            [req.params.storeId]
        );
        res.json(products);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao carregar produtos' });
    }
});

app.post('/api/products', authenticateToken, async (req, res) => {
    if (req.user.type !== 'store') return res.status(403).json({ error: 'Acesso negado' });
    
    try {
        const { name, price, description, image_url, category } = req.body;
        const [result] = await pool.execute(
            'INSERT INTO products (store_id, name, price, description, image_url, category) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.id, name, price, description, image_url, category]
        );
        res.json({ success: true, productId: result.insertId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao adicionar produto' });
    }
});

app.put('/api/products/:id', authenticateToken, async (req, res) => {
    if (req.user.type !== 'store') return res.status(403).json({ error: 'Acesso negado' });
    
    try {
        await pool.execute(
            'UPDATE products SET is_available = ? WHERE id = ? AND store_id = ?',
            [req.body.is_available, req.params.id, req.user.id]
        );
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao atualizar produto' });
    }
});

app.delete('/api/products/:id', authenticateToken, async (req, res) => {
    if (req.user.type !== 'store') return res.status(403).json({ error: 'Acesso negado' });
    
    try {
        await pool.execute('DELETE FROM products WHERE id = ? AND store_id = ?', [req.params.id, req.user.id]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao deletar produto' });
    }
});

// Rotas de Pedidos
app.post('/api/orders', async (req, res) => {
    try {
        const { store_id, customer_name, table_number, items, total_amount, payment_method } = req.body;
        const orderId = uuidv4();
        const orderCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        const connection = await pool.getConnection();
        await connection.beginTransaction();
        
        try {
            await connection.execute(
                'INSERT INTO orders (id, store_id, customer_name, table_number, total_amount, payment_method, order_code, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [orderId, store_id, customer_name, table_number || null, total_amount, payment_method, orderCode, 'pending']
            );
            
            for (const item of items) {
                await connection.execute(
                    'INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?, ?)',
                    [orderId, item.id, item.name, item.quantity, item.price, item.price * item.quantity]
                );
            }
            
            if (payment_method === 'pix') {
                const pixTransactionId = uuidv4();
                const pixCode = `00020126360014br.gov.bcb.pix0114${store_id}5204000053039865404${total_amount.toFixed(2)}5802BR5925Cantina ${store_id}6008SAO PAULO62070503***6304E2CA`;
                const qrCode = await QRCode.toDataURL(pixCode);
                
                await connection.execute(
                    'INSERT INTO pix_transactions (id, order_id, qr_code, pix_code) VALUES (?, ?, ?, ?)',
                    [pixTransactionId, orderId, qrCode, pixCode]
                );
                
                await connection.commit();
                res.json({ orderId, orderCode, qrCode, pixCode, payment_method: 'pix' });
            } else {
                await connection.commit();
                res.json({ orderId, orderCode, payment_method: 'cash' });
            }
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao criar pedido' });
    }
});

app.post('/api/orders/:orderCode/confirm-payment', authenticateToken, async (req, res) => {
    if (req.user.type !== 'attendant') return res.status(403).json({ error: 'Acesso negado' });
    
    try {
        const [result] = await pool.execute(
            'UPDATE orders SET payment_status = "paid", status = "preparing", attendant_id = ? WHERE order_code = ? AND payment_status = "waiting"',
            [req.user.id, req.params.orderCode]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Pedido não encontrado ou já pago' });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao confirmar pagamento' });
    }
});

app.put('/api/orders/:orderId/status', authenticateToken, async (req, res) => {
    const { status } = req.body;
    const validStatus = ['preparing', 'ready', 'delivered', 'cancelled'];
    
    if (!validStatus.includes(status)) {
        return res.status(400).json({ error: 'Status inválido' });
    }
    
    try {
        await pool.execute('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.orderId]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao atualizar status' });
    }
});

app.get('/api/orders/store/:storeId', authenticateToken, async (req, res) => {
    try {
        const [orders] = await pool.execute(
            `SELECT o.*, 
                    GROUP_CONCAT(CONCAT(oi.quantity, 'x ', oi.product_name) SEPARATOR ', ') as items_summary
             FROM orders o
             LEFT JOIN order_items oi ON o.id = oi.order_id
             WHERE o.store_id = ?
             GROUP BY o.id
             ORDER BY o.created_at DESC`,
            [req.params.storeId]
        );
        res.json(orders);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao listar pedidos' });
    }
});

app.get('/api/orders/code/:orderCode', authenticateToken, async (req, res) => {
    try {
        const [orders] = await pool.execute(
            `SELECT o.*, oi.* 
             FROM orders o
             JOIN order_items oi ON o.id = oi.order_id
             WHERE o.order_code = ?`,
            [req.params.orderCode]
        );
        
        if (orders.length === 0) {
            return res.status(404).json({ error: 'Pedido não encontrado' });
        }
        
        res.json(orders);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao buscar pedido' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📱 Cliente: https://seu-app.onrender.com`);
    console.log(`👨‍💼 Atendente: https://seu-app.onrender.com/attendant.html`);
    console.log(`🏪 Loja: https://seu-app.onrender.com/store.html`);
});
