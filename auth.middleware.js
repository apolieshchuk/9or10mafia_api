const jwt = require('jsonwebtoken');

const authMiddleware = function (req, res, next, authType) {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]
    if (token == null) return res.sendStatus(401)
    jwt.verify(token,  'supo-sect-ketyasdzaerfdsd', (err, user) => {
        console.error(err)
        if (err || (user.authType !== authType && authType !== '*')) return res.sendStatus(401)
        req.user = user
        next()
    })
};

const clubAuthMiddleware = function (req, res, next) {
    return authMiddleware(req, res, next, 'Клуб');
};

const userAuthMiddleware = function (req, res, next) {
    return authMiddleware(req, res, next, 'Учасник');
};

const allAuthMiddleware = function (req, res, next) {
    return authMiddleware(req, res, next, '*');
};

module.exports = {
    clubAuthMiddleware,
    userAuthMiddleware,
    allAuthMiddleware
}