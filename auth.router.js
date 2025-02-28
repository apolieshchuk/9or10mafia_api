const express = require('express');
const {MongoClient} = require("mongodb");
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const client = new MongoClient(process.env.MONGO_URL);
let isConnected = false;

const getMongoConnection = async () => {
    if (!isConnected) {
        await client.connect();
        isConnected = true;
        console.log('Connected to MongoDB');
    }
    return client;
}

const getMongoDataClient = async () => {
    const client = await getMongoConnection();
    const db = client.db('mafia9or10');
    // db.collection('clubs').createIndex({ email: 1 }, { unique: true });
    // db.collection('users').createIndex({ email: 1 }, { unique: true });
    return { db, client };
}

// User/Club Login
router.post('/login', async (req, res) => {
    try {
        const { db } = await getMongoDataClient();
        const { email, password, authType } = req.body;
        const col = authType === 'clubs' ? 'clubs' : 'users';
        const friendlyAuthType = authType === 'clubs' ? 'Клуб' : 'Учасник';
        const user = await db.collection(col).findOne({ email, active: true }, {
            projection: { active: 0 },
        })
        if (!user) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const isPasswordMatch = await bcrypt.compare(password, user.password);
        if (!isPasswordMatch) {
            return res.status(401).json({ message: 'Unauthorized' });
        }
        delete user.password;

        const token = jwt.sign({ ...user, authType: friendlyAuthType }, 'supo-sect-ketyasdzaerfdsd', {
            expiresIn: '1w',
        });

        res.status(200).json({ token });
    } catch (e) {
        console.error(e?.message)
    }
    return 'Error';
});

module.exports = router