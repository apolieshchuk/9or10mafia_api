const jwt = require('jsonwebtoken');

module.exports = function (req, res, next) {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]
    if (token == null) return res.sendStatus(401)
    jwt.verify(token,  'supo-sect-ketyasdzaerfdsd', (err, user) => {
        console.error(err)
        if (err) return res.sendStatus(401)
        req.user = user
        next()
    })
};