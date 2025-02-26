const serverless = require("serverless-http");
const express = require("express");
const app = express();
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require("bcrypt");
const { clubAuthMiddleware, userAuthMiddleware, allAuthMiddleware } = require('./auth.middleware');

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
        // const clubs = await db.collection('clubs').find({ active: true }).project({ email: 1, name: 1, address: 1 });
        const clubsAgg = await db.collection('clubs').aggregate([
            { $match: { active: true } },
            { $lookup: { from: 'users', localField: '_id', foreignField: 'clubs', as: 'users' } },
            { $project: { email: 1, name: 1, address: 1, users: { $size: '$users' } } },
        ]);
        const clubs = await clubsAgg.toArray();
        return res.status(200).json({
            items: clubs,
        });
    } catch (e) {
        console.error(e?.message)
    }
});

app.post("/club/join", userAuthMiddleware, async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const { clubId } = req.body;
        await db.collection('users').updateOne({ email: req.user.email }, { $addToSet: { clubs: ObjectId(clubId) } });
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

app.post("/club/rating-game", clubAuthMiddleware, async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const clubId = new ObjectId(req.user._id);
        const { players, winState, votings } = req.body;
        const ratingPeriod = await db.collection('rating_periods').findOne({ club: clubId }, { sort: { _id: -1 } });
        if (!ratingPeriod) {
            return res.status(422).json({
                error: 'Rating period not found',
            });
        }
        const ratingPeriodId = ratingPeriod._id;
        await db.collection('games')
            .insertOne({
                club: clubId,
                ratingPeriod: ratingPeriodId,
                players,
                winState,
                votings,
                createdAt: new Date(),
            });
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
        await db.collection('users').insertOne({
            ...req.body,
            password: hashedPassword,
            active: true,
            clubs: req.body.clubs?.map(clubId => new ObjectId(clubId)) || [],
        });
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
        const usersAgg = await db.collection('users').aggregate([
            { $match: { active: true } },
            { $lookup: { from: 'clubs', localField: 'clubs', foreignField: '_id', as: 'clubs' } },
            { $project: { name: 1, nickname: 1, email: 1, 'clubs.active': 1, 'clubs.name': 1, 'clubs._id': 1 } },
        ]);
        let users = await usersAgg.toArray();
        users = users.map(user => {
            user.clubs = user.clubs.filter(club => club.active);
            user.clubs = user.clubs.map(club => club.name);
            user.clubs = user.clubs.join(', ');
            return user;
        });
        return res.status(200).json({
            items: users,
        });
    } catch (e) {
        console.error(e?.message)
    }
});

app.get("/club/users", clubAuthMiddleware, async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const users = await db.collection('users')
            .find({ clubs: new ObjectId(req.user._id), active: true })
            .project({ name: 1, nickname: 1, email: 1 });
        return res.status(200).json({
            items: await users.toArray(),
        });
    } catch (e) {
        console.error(e?.message)
    }
});

app.get("/user/clubs", userAuthMiddleware, async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const clubs = await db.collection('users').aggregate([
            { $match: { email: req.user.email, active: true } },
            { $lookup: { from: 'clubs', localField: 'clubs', foreignField: '_id', as: 'clubs' } },
            { $project: { 'clubs.email': 1, 'clubs.name': 1, 'clubs.address': 1 } },
            { $unwind: '$clubs' },
            { $project: { email: '$clubs.email', name: '$clubs.name', address: '$clubs.address' } },
        ]);
        return res.status(200).json({
            items: await clubs.toArray(),
        });
    } catch (e) {
        console.error(e?.message)
    }
});

app.post("/club/rating-period", clubAuthMiddleware, async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const { name } = req.body;
        await db.collection('rating_periods')
            .insertOne({ name, club: new ObjectId(req.user._id) });
        return res.status(200).json({
            status: 'Success',
        });
    } catch (e) {
        console.error(e?.message)
    }
});

app.get("/club/rating-periods", allAuthMiddleware, async (req, res, next) => {
    try {
        const { db } = await getMongoDataClient();
        const clubs = []
        if (req.user.authType === 'Клуб') {
            clubs.push(new ObjectId(req.user._id));
        } else {
            const user = await db.collection('users').findOne({ email: req.user.email });
            clubs.push(...(user.clubs || []).map(clubId => new ObjectId(clubId)));
        }

        const periods = await db.collection('rating_periods').aggregate([
            { $match: { club: { $in: clubs } } },
            { $lookup: { from: 'clubs', localField: 'club', foreignField: '_id', as: 'club' } },
            { $project: { name: 1, club: { $arrayElemAt: ['$club', 0] } } },
            { $sort: { 'club._id': -1, _id: -1 } },
            { $project: { name: 1, club: '$club.name', clubId: '$club._id'} },
        ]);
        let items = await periods.toArray();
        const map = {}
        items = items.map(item => {
            const isLatest = map[item.clubId];
            if (!isLatest) {
                map[item.clubId] = true;
                return ({ ...item, active: true });
            }
            return ({ ...item, active: false });
        });
        console.log(`--->`, items, 'handler.js:204')
        return res.status(200).json({ items });
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