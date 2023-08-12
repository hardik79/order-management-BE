const jwt = require("jsonwebtoken");

function authenticateToken(req, res, next) {
    const token = req.headers.authorization && req.headers.authorization.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Authorization token not provided' });
    }
  
    jwt.verify(token, 'mvpsecret', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
  
        req.user = user;
        next();
    });
}

module.exports = authenticateToken;