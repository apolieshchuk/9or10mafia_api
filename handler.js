const serverless = require("serverless-http");
const express = require("express");
const app = express();
const { MongoClient } = require('mongodb');
const bcrypt = require("bcrypt");
const authMiddleware = require('./auth.middleware');

app.use(express.json());       // to support JSON-encoded bodies
app.use(express.urlencoded({ extended: true })); // to support URL-encoded bodies
// app.use(cors({
//   // origin: `https://admin.${process.env.ENV}.usgua.click`,
//   origin: `*`,
//   methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
//   credentials: true,
// }));
// app.use(cors());
// let client = null;

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
    db.collection('clubs').createIndex({ email: 1 }, { unique: true });
    db.collection('users').createIndex({ email: 1 }, { unique: true });
    return { db, client };
}

app.use('/auth', require('./auth.router'));

app.post("/club", async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const { password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.collection('clubs').insertOne({ ...req.body, password: hashedPassword, active: true });
        return res.status(200).json({
            data: 'Success',
        });
    } catch (e) {
        console.error(e?.message)
        if (e?.message?.startsWith('E11000')) {
            return res.status(409).json({
                error: 'Duplicate email',
            });
        }
        return res.status(500).json({
            error: 'Server Error',
        });
    }
});

app.get("/clubs", async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const clubs = await db.collection('clubs').find({ active: true }).project({ email: 1, name: 1, address: 1 });
        return res.status(200).json({
            items: await clubs.toArray(),
        });
    } catch (e) {
        console.error(e?.message)
    }
});

app.post("/clubs/join", authMiddleware, async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const { clubId } = req.body;
        await db.collection('users').updateOne({ email: req.user.email }, { $addToSet: { clubs: clubId } });
        return res.status(200).json({
            data: 'Success',
        });
    } catch (e) {
        console.error(e?.message)
        return res.status(500).json({
            error: 'Server Error',
        });
    }
});

app.post("/user", async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const { password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.collection('users').insertOne({ ...req.body, password: hashedPassword, active: true });
        return res.status(200).json({
            data: 'Success',
        });
    } catch (e) {
        console.error(e?.message)
        if (e?.message?.startsWith('E11000')) {
            return res.status(409).json({
                error: 'Duplicate email',
            });
        }
        return res.status(500).json({
            error: 'Server Error',
        });
    }
});

app.get("/users", async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const users = await db.collection('users').find({ active: true }).project({ name: 1, nickname: 1 });
        return res.status(200).json({
            items: await users.toArray(),
        });
    } catch (e) {
        console.error(e?.message)
    }
});

app.get("/clubs/users", async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const users = await db.collection('users').find({ active: true }).project({ name: 1, nickname: 1, email: 1 });
        return res.status(200).json({
            items: await users.toArray(),
        });
    } catch (e) {
        console.error(e?.message)
    }
});

app.get("/", async (req, res, next) => {
    const { db } = await getMongoDataClient();
    return res.status(200).json({
        items: await db.collection('users').find({}).toArray(),
    });
});

app.get("/hello", (req, res, next) => {
    return res.status(200).json({
        message: "Hello from path!",
    });
});

app.use((req, res, next) => {
    return res.status(404).json({
        error: "Not Found",
    });
});

exports.handler = serverless(app);