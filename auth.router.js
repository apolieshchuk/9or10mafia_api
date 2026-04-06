const express = require('express');
const {MongoClient} = require("mongodb");
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://9or10mafia.com';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

async function sendPasswordResetEmailResend({ to, subject, html }) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        throw new Error('RESEND_API_KEY is not configured');
    }
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: RESEND_FROM_EMAIL,
            to: [to],
            subject,
            html,
        }),
    });
    const bodyText = await res.text();
    if (!res.ok) {
        throw new Error(`Resend ${res.status}: ${bodyText}`);
    }
}

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

/** Trim + lowercase; порівняння з полем email у БД без урахування регістру ($expr). */
function normalizeEmailForLookup(email) {
    if (email == null || typeof email !== 'string') return '';
    return email.trim().toLowerCase();
}

function activeUserByNormalizedEmailQuery(emailNorm) {
    return {
        active: true,
        $expr: {
            $eq: [
                { $toLower: { $trim: { input: { $ifNull: ['$email', ''] } } } },
                emailNorm,
            ],
        },
    };
}

// User/Club Login
router.post('/login', async (req, res) => {
    try {
        const { db } = await getMongoDataClient();
        const { email, password, authType } = req.body;
        const emailNorm = normalizeEmailForLookup(email);
        if (!emailNorm) {
            return res.status(401).json({ message: 'Unauthorized' });
        }
        const col = authType === 'clubs' ? 'clubs' : 'users';
        const friendlyAuthType = authType === 'clubs' ? 'Клуб' : 'Учасник';
        const user = await db.collection(col).findOne(activeUserByNormalizedEmailQuery(emailNorm), {
            projection: { active: 0 },
        });
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

        return res.status(200).json({ token });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ message: 'Server error' });
    }
});

async function findUserByEmail(db, email) {
    const emailNorm = normalizeEmailForLookup(email);
    if (!emailNorm) return null;
    const q = activeUserByNormalizedEmailQuery(emailNorm);
    const user = await db.collection('users').findOne(q);
    if (user) return { user, collection: 'users' };
    const club = await db.collection('clubs').findOne(q);
    if (club) return { user: club, collection: 'clubs' };
    return null;
}

router.post('/forgot-password', async (req, res) => {
    try {
        const { db } = await getMongoDataClient();
        const { email } = req.body;
        const emailNorm = normalizeEmailForLookup(email);
        if (!emailNorm) return res.status(422).json({ message: 'Email is required' });

        const found = await findUserByEmail(db, email);
        if (!found) return res.status(200).json({ message: 'ok' });

        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiry = new Date(Date.now() + 3600000);

        await db.collection(found.collection).updateOne(
            { _id: found.user._id },
            { $set: { resetToken, resetTokenExpiry } }
        );

        const resetLink = `${FRONTEND_URL}/reset-password?token=${resetToken}`;
        const html = `
                        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
                            <h2 style="color:#1976d2">Відновлення паролю</h2>
                            <p>Ви отримали цей лист, тому що хтось запросив відновлення паролю для вашого облікового запису.</p>
                            <p><a href="${resetLink}" style="display:inline-block;padding:12px 24px;background:#1976d2;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Встановити новий пароль</a></p>
                            <p style="color:#888;font-size:13px">Посилання дійсне 1 годину. Якщо ви не запитували відновлення — проігноруйте цей лист.</p>
                        </div>
                    `;
        await sendPasswordResetEmailResend({
            to: found.user.email,
            subject: 'Відновлення паролю — 9or10 Mafia',
            html,
        });

        res.status(200).json({ message: 'ok' });
    } catch (e) {
        console.error('forgot-password error:', e?.message);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/reset-password', async (req, res) => {
    try {
        const { db } = await getMongoDataClient();
        const { token, password } = req.body;
        if (!token || !password) return res.status(422).json({ message: 'Token and password are required' });
        if (password.length < 6) return res.status(422).json({ message: 'Password must be at least 6 characters' });

        const query = { resetToken: token, resetTokenExpiry: { $gt: new Date() } };
        const user = await db.collection('users').findOne(query) ||
                     await db.collection('clubs').findOne(query);

        if (!user) return res.status(400).json({ message: 'Токен недійсний або прострочений' });

        const collection = await db.collection('users').findOne({ _id: user._id }) ? 'users' : 'clubs';
        const hashedPassword = await bcrypt.hash(password, 10);

        await db.collection(collection).updateOne(
            { _id: user._id },
            { $set: { password: hashedPassword }, $unset: { resetToken: '', resetTokenExpiry: '' } }
        );

        res.status(200).json({ message: 'ok' });
    } catch (e) {
        console.error('reset-password error:', e?.message);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router