const express = require('express');
const {MongoClient} = require("mongodb");
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://9or10mafia.com';

/* ——— Resend (вимкнено; залишено для історії) ———
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
——— */

/* ——— Twilio SendGrid (вимкнено; залишено для історії) ———
const SENDGRID_FROM_EMAIL = (process.env.SENDGRID_FROM_EMAIL || '').trim();
const SENDGRID_FROM_NAME = (process.env.SENDGRID_FROM_NAME || '9or10 Mafia').trim();

async function sendPasswordResetEmailSendGrid({ to, subject, html }) {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
        throw new Error('SENDGRID_API_KEY is not configured');
    }
    if (!SENDGRID_FROM_EMAIL) {
        throw new Error('SENDGRID_FROM_EMAIL is not configured');
    }
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            personalizations: [{ to: [{ email: to }] }],
            from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
            subject,
            content: [{ type: 'text/html', value: html }],
        }),
    });
    if (!res.ok) {
        const bodyText = await res.text();
        throw new Error(`SendGrid ${res.status}: ${bodyText}`);
    }
}
——— */

/**
 * Mailtrap: https://mailtrap.io/api-tokens
 * Токен: MAILTRAP_API_TOKEN (або MAILTRAP_API_KEY).
 * Відправка: transactional https://send.api.mailtrap.io/api/send (потрібен верифікований sending domain).
 * Тестовий inbox: MAILTRAP_USE_SANDBOX=true + MAILTRAP_INBOX_ID → https://sandbox.api.mailtrap.io/api/send/{id}
 */
const MAILTRAP_FROM_EMAIL = (process.env.MAILTRAP_FROM_EMAIL || '').trim();
const MAILTRAP_FROM_NAME = (process.env.MAILTRAP_FROM_NAME || '9or10 Mafia').trim();
const MAILTRAP_USE_SANDBOX = String(process.env.MAILTRAP_USE_SANDBOX || '').toLowerCase() === 'true';
const MAILTRAP_INBOX_ID = (process.env.MAILTRAP_INBOX_ID || '').trim();

function getMailtrapSendUrl() {
    if (MAILTRAP_USE_SANDBOX) {
        if (!MAILTRAP_INBOX_ID) {
            throw new Error('MAILTRAP_INBOX_ID is required when MAILTRAP_USE_SANDBOX=true');
        }
        return `https://sandbox.api.mailtrap.io/api/send/${encodeURIComponent(MAILTRAP_INBOX_ID)}`;
    }
    return 'https://send.api.mailtrap.io/api/send';
}

function mailtrapApiToken() {
    return (process.env.MAILTRAP_API_TOKEN || process.env.MAILTRAP_API_KEY || '').trim();
}

async function sendPasswordResetEmailMailtrap({ to, subject, html }) {
    const token = mailtrapApiToken();
    if (!token) {
        throw new Error('MAILTRAP_API_TOKEN (or MAILTRAP_API_KEY) is not configured');
    }
    if (!MAILTRAP_FROM_EMAIL) {
        throw new Error('MAILTRAP_FROM_EMAIL is not configured');
    }
    const url = getMailtrapSendUrl();
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: { email: MAILTRAP_FROM_EMAIL, name: MAILTRAP_FROM_NAME },
            to: [{ email: to }],
            subject,
            html,
            category: 'password-reset',
        }),
    });
    if (!res.ok) {
        const bodyText = await res.text();
        throw new Error(`Mailtrap ${res.status}: ${bodyText}`);
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
        await sendPasswordResetEmailMailtrap({
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