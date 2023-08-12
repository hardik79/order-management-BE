const express = require('express')
const bcrypt = require('bcrypt');
const cors = require('cors')
const jwt = require('jsonwebtoken');
const mysql = require('mysql')
const util = require('util');

const auth = require("./middleware/auth");

const app = express()
const PORT = 3000;

const db = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'mvp'
}

const pool = mysql.createPool(db);
const conn = mysql.createConnection(db);

app.use(express.json());
app.use(cors());

app.get('/', (req, res) => {
    res.send('Hello World!')
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
  
    pool.query('SELECT * FROM users WHERE username = ?', username, (err, result) => {
        if (err) {
            return res.status(500).json({ error: 'Error fetching user' });
        }
  
        if (!result.length) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result[0];

        bcrypt.compare(password, user.password, (bcryptErr, bcryptResult) => {
            if (bcryptErr || !bcryptResult) {
                return res.status(401).json({ error: 'Authentication failed' });
            }

            const token = jwt.sign({ userId: user.id }, 'mvpsecret', { expiresIn: '1h' });
            return res.status(200).json({ token });
        });
    });
});

app.post('/load-order/:id', auth, async (req, res) => {
    const id = req.params.id;
    const packer_id = req.user.userId;

    // check if order is already assigned to a packer
    const packer_sql = `SELECT
        o.packer_id,
        u.username
        FROM users u
        INNER JOIN orders o ON u.id = o.packer_id
        WHERE o.id = ?
    `;

    const order_items_query = `SELECT
        i.id,
        i.product_id,
        i.qty,
        i.qty_packed,
        i.status,
        p.name,
        p.sku,
        p.name,
        p.image
        FROM order_items i
        INNER JOIN products p
            ON i.product_id = p.id
        WHERE order_id = ?
    `;

    try {
        const [packer, order, items] = await Promise.all([
            util.promisify(pool.query).bind(pool)(packer_sql, id),
            util.promisify(pool.query).bind(pool)('SELECT * FROM orders WHERE id = ?', id),
            util.promisify(pool.query).bind(pool)(order_items_query, id)
        ]);

        let data = {
            packer_id
        }
        if (packer.length) {
            const packer_name = packer[0].username;
            return res.status(400).json({ error: `Order is already assigned to ${packer_name}` });
        }
    
        // re-assign the order to the currently logged in user
        const sql = "UPDATE orders SET ? WHERE id = ?";
        pool.query(sql, [data, id], (err) => {
            if (err) {
                return res.send(err.message);
            }
        });

        return res.status(200).json({ order, items });
    } catch (err) {
        return res.status(500).json({ error: 'Error executing the queries' });
    }
});
app.get('/get-order', (req, res) => {

    const sql = 'SELECT * FROM ORDERS';
    pool.query(sql, function (err, result) {
        if (err) {
            return res.send(err.message);
        }

        if (!result.length) {
            return res.status(404).json({ 'error': 'Order not found' });
        }
        
        if (result.length > 0) {
            return res.send(result);
        }

    });
});

app.post('/search-sku/:sku', auth, (req, res) => {
    const sku = req.params.sku;
    const packer_id = req.user.userId;

    const search_sku_query = `SELECT
        i.id,
        i.product_id,
        i.qty,
        i.qty_packed,
        i.status,
        p.name,
        p.sku,
        p.name,
        p.image
        FROM order_items i
        INNER JOIN products p
            ON i.product_id = p.id
        WHERE p.sku = ?
    `;

    pool.query(search_sku_query, sku, (err, result) => {
        if (err) {
            return res.status(500).json({ error: 'Error fetching product' });
        }

        if (!result.length) {
            return res.status(404).json({ error: 'Product not found' });
        }

        return res.send(result);
    });
});

// verify order status - call this before submitting an order
app.get('/check-order-status/:id', (req, res) => {
    const { id } = req.params.id;

    const sql = 'SELECT * FROM `ORDERS WHERE id = ?';
    pool.query(sql, id, function (err, result) {
        if (err) {
            return res.send(err.message);
        }

        if (!result.length) {
            return res.status(404).json({ 'error': 'Order not found' });
        }
    });

    const select_sql = 'SELECT * FROM `order_items` WHERE (qty_packed < qty) AND order_id = ?';
    pool.query(select_sql, id, function (err, result) {
        if (err) {
            return res.send(err.message);
        }

        if (result.length > 0) {
            return res.send({ 'code': '200B', 'message': 'Warning. Not all items have been packed' });
        }

        return res.send({ 'code': '200A', 'message': 'All good to go!' });
    });
});

// use this endpoint when submitting an order
app.post('/submit-order', auth, (req, res) => {
    const { id } = req.body;
    const packer_id = req.user.userId;

    const update_sql = 'UPDATE orders SET ? WHERE id = ?';
    const update_data = {
        status: 'P'
    }

    pool.query(update_sql, [update_data, id], function(err, result) {
        if (err) {
            return res.send(err.message);
        }

        return res.status(202).json({ 'message': 'Order successfully submitted' });
    });
});

function pick_item(id, cb) {
    let qty = 0;
    let qty_packed = 0;
    let obj = {};

    conn.query('SELECT * FROM order_items WHERE id = ?', id, function (err, result) {
        if (err) {
            return res.send(err.message);
        }

        if (!result.length) {
            return res.status(404).json({ error: 'Item not found' });
        }

        qty = result[0].qty;
        qty_packed = result[0].qty_packed;

        obj = {
            qty,
            qty_packed
        }

        cb(null, obj);
    });
}

function update_item(id, order_id, qty, qty_packed, qty_picked, cb) {
    let obj = {};

    const update_sql = 'UPDATE order_items SET ? WHERE id = ?';
    const update_data = {
        qty_packed: qty_packed + qty_picked
    }

    if (qty_picked < (qty - qty_packed)) {
        obj = {
            "status": "P",
            "message": "Item picked"
        }
    } else {
        obj = {
            status: "P",
            message: "Item completed"
        }
    }

    // check if all line items are completely packed
    const select_sql = 'SELECT * FROM `order_items` WHERE (qty_packed < qty) AND order_id = ?';
    const query = util.promisify(pool.query).bind(pool);

    Promise.all([query(update_sql, [update_data, id])])
        .then(() => {
            query(select_sql, order_id).then((result) => {
                // no more unpacked items
                if (!result.length) {
                    const packed_data = {
                        status: 'K'
                    }

                    // update order and set status to packed (K)
                    const packed_sql = 'UPDATE orders SET ? WHERE id = ?';
                    query(packed_sql, [packed_data, order_id]);

                    obj = {
                        "status": 'K',
                        "message": "Order status changed to Packed"
                    }
                }

                cb(null, obj);
            });
        });
}

// ideally, we should also log the order id but since
// it's not in the test instructions, i will just include
// that info in the action message
function log_event(order_id, packer_id, ip_addr, action) {
    const sql = `INSERT INTO events (user_id, ip_addr, action) VALUES (?, ?, ?)`;

    const values = [
        packer_id,
        ip_addr,
        action
    ];

    pool.query(sql, values, (err, results) => {
        // if (err) {
        //     return res.send(err.message);
        // }

        //return res.status(201).json({ 'message': results.insertId });
        console.log('Event has been logged');
    });
}

app.post('/pick-item', auth, async (req, res, cb) => {
    const { id, order_id, qty_picked, ip_addr } = req.body;
    const packer_id = req.user.userId;

    pick_item(id, function(error, obj) {
        let qty = obj.qty;
        let qty_packed = obj.qty_packed

        if (qty_picked < 1) {
            return res.status(400).json({ error: 'Quantity cannot be less than 1' });
        }

        if (qty_picked > (qty - qty_packed)) {
            return res.status(400).json({ error: 'Quantity cannot be greater than the total items or number of unpicked items' });
        }

        update_item(id, order_id, qty, qty_packed, qty_picked, function(error, obj) {
            let status = obj.status;
            let message = obj.message;

            let action = `Picked item #${id} for order #${order_id}`;
            log_event(order_id, packer_id, ip_addr, action);

            return res.send({ "status": status, "message": message });
        });
    });
});

app.post('/unpick-item', auth, (req, res) => {
    const { id, order_id, ip_addr } = req.body;
    const packer_id = req.user.userId;

    pool.query('SELECT * FROM order_items WHERE id = ?', id, (err, result) => {
        if (err) {
            return res.status(500).json({ error: 'Error fetching item' });
        }
  
        if (!result.length) {
            return res.status(404).json({ error: 'Item not found' });
        }

        const sql = "UPDATE order_items SET ? WHERE id = ?";
        let data = {
            qty_packed: 0
        }

        pool.query(sql, [data, id], (err) => {
            if (err) {
                return res.send(err.message);
            }

            let action = `Picked item #${id} for order #${order_id}`;
            log_event(order_id, packer_id, ip_addr, action);

            return res.send("Item un-picked");
        });
    });
});

// use this endpoint to un-assign an order if app has been idle for 5 minutes
app.post('/unassign-order', (req, res) => {
    const { id } = req.body;

    // let's just assume that the order exists,
    // skip verification to save development time

    const sql = "UPDATE orders SET ? WHERE id = ?";
    let data = {
        packer_id: null
    }

    pool.query(sql, [data, id], (err) => {
        if (err) {
            return res.send(err.message);
        }

        return res.status(202).json({ 'message': 'Order has been unassigned' });
    });
});

/*
app.get('/products', (req, res) => {
    pool.query('SELECT * FROM products', (err, result) => {
        if (err) {
            return res.status(500).json({ error: 'Error fetching products' });
        }

        if (!result.length) {
            return res.status(404).json({ error: 'No products found' });
        }

        return res.send(result);
    });
});

app.get('/product/:id', (req, res) => {
    const id = req.params.id;

    pool.query('SELECT * FROM products WHERE id = ?', id, (err, result) => {
        if (err) {
            return res.status(500).json({ error: 'Error fetching product' });
        }

        if (!result.length) {
            return res.status(404).json({ error: 'Product not found' });
        }

        return res.send(result);
    });
});
*/

/*
app.post('/create-order', (req, res) => {
    const { packer_id, firstname, lastname, address, state, suburb, postcode, country, date_placed } = req.body;
    const sql = `INSERT INTO orders (
        packer_id,
        firstname,
        lastname,
        address,
        state,
        suburb,
        postcode,
        country,
        date_placed,
        status,
        created_at
    ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`;
    const ct = Date.now();

    const values = [
        packer_id,
        firstname,
        lastname,
        address,
        state,
        suburb,
        postcode,
        country,
        date_placed,
        'P',
        ct
    ];

    pool.query(sql, values, (err, results) => {
        if (err) {
            return res.send(err.message);
        }

        return res.send(results.insertId);
    });
});
*/

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
});
