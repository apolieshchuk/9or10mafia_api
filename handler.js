const serverless = require("serverless-http");
const express = require("express");
const app = express();
const cors = require('cors')
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require("bcryptjs");
const { clubAuthMiddleware, userAuthMiddleware, allAuthMiddleware } = require('./auth.middleware');
const jwt = require("jsonwebtoken");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' });
const S3_BUCKET = process.env.S3_BUCKET || 'mafia9or10-avatars';

app.use(cors())
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true })); // to support URL-encoded bodies
// app.use(cors({
//   // origin: `https://admin.${process.env.ENV}.usgua.click`,
//   origin: `*`,
//   methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
//   credentials: true,
// }));
// app.use(cors());
// let client = null;

// const client = new MongoClient(process.env.MONGO_URL);
// let isConnected = false;
//
// const getMongoConnection = async () => {
//     if (!isConnected) {
//         await client.connect();
//         isConnected = true;
//         console.log('Connected to MongoDB');
//     }
//     return client;
// }

const getMongoDataClient = async () => {
    const client = new MongoClient(process.env.MONGO_URL);
    await client.connect();
    const db = client.db('mafia9or10');
    // db.collection('clubs').createIndex({ email: 1 }, { unique: true });
    // db.collection('clubs').createIndex({ name: 1 }, { unique: true });
    // db.collection('users').createIndex({ email: 1 }, { unique: true });
    return { db, client };
}

app.use('/auth', require('./auth.router'));

app.post("/club", async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
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
    } finally {
        await client.close(true);
    }
});

app.post("/club/rating", async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
        const clubId = new ObjectId(req.body.clubId);
        const latestRatingPeriod = await db.collection('rating_periods').findOne({ club: clubId }, { sort: { _id: -1 } });
        const [yearStats, periodStats] = await calculateTotalGamesInfo(db, clubId, latestRatingPeriod);

        const users = await db.collection('games').aggregate([
            { $match: { club: clubId, ratingPeriod: latestRatingPeriod._id  } },
            { $addFields: { usersId: { $map: { input: '$players', as: 'player', in: '$$player.id' } } }},
            { $unwind: '$usersId' },
            { $match: { 'usersId': { $ne: null } } },
            { $group: { _id: '$usersId', games: { $push: '$$ROOT' } } },
            { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
            { $unwind: '$user' },
            { $project: { games: 1, name: '$user.name', nickname: '$user.nickname', avatarUrl: '$user.avatarUrl' } },
        ]);

        // Коефіцієнт складної карти
        const hardRoles = periodStats.citizensWins > periodStats.mafiaWins ? ['maf', 'don'] : ['cit', 'sher'];
        const usersStats = {};
        for await (let user of users) {
            const games = user.games;
            const totalGames = games.length;
            usersStats[user._id] = {
                id: user._id,
                name: user.name,
                nickname: user.nickname,
                avatarUrl: user.avatarUrl || '',
                totalGames,
                totalWins: 0,
                mafiaGames: 0,
                mafiaWins: 0,
                mafiaWinsRate: 0,
                citizenGames: 0,
                citizenWins: 0,
                citizenWinsRate: 0,
                sheriffGames: 0,
                sheriffWins: 0,
                sheriffWinsRate: 0,
                donGames: 0,
                donWins: 0,
                donWinsRate: 0,
                points: 0,
                rating: 0,
                supportFivePoints: 0,
                supportFiveCount: 0,
                bonusPoints: 0,
                firsDie: 0,
                hardRoleGames: 0,
                hardRoleRate: 0,
            }
            for (let game of games) {
                const { points, player, supportFivePoints, bonus, isWinner, winner} = calculateRating(game, user._id);
                usersStats[user._id].points += points;

                if (hardRoles.includes(normalizeRole(player.role))) {
                    usersStats[user._id].hardRoleGames += 1;
                }

                const op5Guesses = (player.bestTurn || []).filter(g => typeof g === 'object' && g !== null && g.color);
                if (isFirstDie(player) && op5Guesses.length > 0) {
                    usersStats[user._id].supportFivePoints += supportFivePoints;
                    usersStats[user._id].supportFiveCount++;
                }
                usersStats[user._id].totalWins += isWinner ? 1 : 0;
                usersStats[user._id].totalWinsRate = pct(usersStats[user._id].totalWins, usersStats[user._id].totalGames);
                if (isMafia(player)) {
                    usersStats[user._id].mafiaGames++;
                    usersStats[user._id].mafiaWins += isWinner ? 1 : 0;
                    usersStats[user._id].mafiaWinsRate = pct(usersStats[user._id].mafiaWins, usersStats[user._id].mafiaGames);
                }
                if (isSheriff(player)) {
                    usersStats[user._id].sheriffGames++;
                    usersStats[user._id].sheriffWins += isWinner ? 1 : 0;
                    usersStats[user._id].sheriffWinsRate = pct(usersStats[user._id].sheriffWins, usersStats[user._id].sheriffGames);
                }
                if (isGood(player)) {
                    usersStats[user._id].citizenGames++;
                    usersStats[user._id].citizenWins += isWinner ? 1 : 0;
                    usersStats[user._id].citizenWinsRate = pct(usersStats[user._id].citizenWins, usersStats[user._id].citizenGames);
                }
                if (isDon(player)) {
                    usersStats[user._id].donGames++;
                    usersStats[user._id].donWins += isWinner ? 1 : 0;
                    usersStats[user._id].donWinsRate = pct(usersStats[user._id].donWins, usersStats[user._id].donGames);
                }
                usersStats[user._id].bonusPoints = Math.round((usersStats[user._id].bonusPoints + bonus) * 10) / 10;
                usersStats[user._id].firsDie += isFirstDie(player) ? 1 : 0;
            }

            usersStats[user._id].rating = Math.round(
                (pct(usersStats[user._id].points, usersStats[user._id].totalGames)
                    + usersStats[user._id].supportFivePoints * 10
                    + usersStats[user._id].bonusPoints * 10
                ) * 10
            ) / 10;

            usersStats[user._id].hardRoleRate = Math.round((1+(((periodStats.totalGames/2) - usersStats[user._id].hardRoleGames)/(periodStats.totalGames/2))) * 10) / 10;
        }

        const allUsersGames = Object.values(usersStats).reduce((acc, user) => acc + user.totalGames, 0);
        const avgGames = Math.floor(allUsersGames / Object.keys(usersStats).length);

        const sortByRating = Object.values(usersStats).sort((a, b) => {
            // const aRating = a.rating + (a.totalGames > 9 ? 1000 : 0) + (a.totalGames > 19 ? 1000 : 0) + (a.totalGames > 29 ? 1000 : 0);
            // const bRating = b.rating + (b.totalGames > 19 ? 1000 : 0) + (b.totalGames > 29 ? 1000 : 0);
            const aRating = a.rating + (a.totalGames >= avgGames ? 1000 : 0);
            const bRating = b.rating + (b.totalGames >= avgGames ? 1000 : 0);

            if (aRating !== bRating) {
                return bRating - aRating
            }
            return b.totalGames - a.totalGames;
        });
        return res.status(200).json({
            players: sortByRating.map((player, i) => ({...player, rank: i + 1})),
            stats: {
                yearStats: [...yearStats],
                avgGames,
            },
        });
    } catch (e) {
        console.error(e?.message)
        return res.status(500).json({
            error: 'Server Error',
        });
    } finally {
        await client.close(true);
    }
});

const calculateTotalGamesInfo = async (db, clubId, latestRatingPeriod) => {
    // total games info for last 12 months
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    const gamesTotal1Year = await db.collection('games').find({ club: clubId, createdAt: { $gte: yearAgo } })
    const defaultTotalStats = {
        totalGames: 0,
        citizensWins: 0,
        mafiaWins: 0,
    }
    const [mnthNums, mnthNames] = getLast12Months();
    // calculate games stats
    const yearStats = mnthNums.reduce((acc, monthNum, i) => {
        const m = { ...defaultTotalStats, name: mnthNames[i] };
        acc.set(Number(monthNum), m);
        return acc;
    }, new Map());
    const periodStats = { ...defaultTotalStats };
    let tgInPeriod = 0;
    for await (let game of gamesTotal1Year) {
        const mnth = game.createdAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }).split('/')[0];
        const current = yearStats.get(Number(mnth));
        const newMnth = {
            ...current,
            totalGames: current.totalGames + 1,
            citizensWins: current.citizensWins + (game.winState === 'mafia' ? 0 : 1),
            mafiaWins: current.mafiaWins + (game.winState === 'mafia' ? 1 : 0),
        };
        yearStats.set(Number(mnth), newMnth);
        if (String(game.ratingPeriod) === String(latestRatingPeriod._id)) {
            periodStats.totalGames++;
            periodStats.citizensWins += game.winState === 'mafia' ? 0 : 1;
            periodStats.mafiaWins += game.winState === 'mafia' ? 1 : 0;
        }
    }
    return [yearStats, periodStats];
}

app.get("/clubs", async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
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
        return res.status(500).json({
            error: 'Server Error',
        });
    } finally {
        await client.close(true);
    }
});

app.post("/club/join", userAuthMiddleware, async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
        const { clubId } = req.body;
        await db.collection('users').updateOne({ email: req.user.email }, { $addToSet: { clubs: new ObjectId(clubId) } });
        return res.status(200).json({
            data: 'Success',
        });
    } catch (e) {
        console.error(e?.message)
        return res.status(500).json({
            error: 'Server Error',
        });
    } finally {
        await client.close(true);
    }
});

app.post("/club/rating-game", clubAuthMiddleware, async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
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
                players: players.map(player => ({ ...player, role: normalizeRole(player.role), id: player.id && new ObjectId(player.id) })),
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
    } finally {
        await client.close(true);
    }
});

app.get("/club/last-game-players", clubAuthMiddleware, async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
        const clubId = new ObjectId(req.user._id);
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const lastGame = await db.collection('games').findOne(
            { club: clubId, createdAt: { $gte: since } },
            { sort: { createdAt: -1 } }
        );
        if (!lastGame) return res.status(200).json({ players: [] });

        const realPlayers = (lastGame.players || [])
            .filter(p => p.id)
            .map(p => ({ title: p.title, id: p.id }));

        const seats = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        for (let i = seats.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [seats[i], seats[j]] = [seats[j], seats[i]];
        }
        const result = realPlayers.map((p, i) => ({ ...p, seat: seats[i] }));

        return res.status(200).json({ players: result });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

app.post("/user", async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
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
    } finally {
        await client.close(true);
    }
});
app.put("/user", allAuthMiddleware, async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
        if (!req.user._id) {
            return res.status(422).json({
                error: 'User id is required',
            });
        }
        const userId = new ObjectId(req.user._id);
        const { nickname } = req.body;
        if (!nickname) {
            return res.status(422).json({
                error: 'Nickname is required',
            });
        }
        await db.collection('users').updateOne( { _id: userId },{
            $set: { nickname },
        });

        const token = jwt.sign({
            _id: req.user._id,
            name: req.user.name,
            email: req.user.email,
            nickname,
            clubs: req.user.clubs,
            authType: req.user.authType
        }, 'supo-sect-ketyasdzaerfdsd', {
            expiresIn: '1w',
        });

        res.status(200).json({ token });
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
    } finally {
        await client.close(true);
    }
});

app.post("/user/avatar", allAuthMiddleware, async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
        const { image } = req.body;
        if (!image) return res.status(422).json({ error: 'Image is required' });

        const matches = image.match(/^data:image\/(jpeg|png|jpg);base64,(.+)$/);
        if (!matches) return res.status(422).json({ error: 'Invalid image format' });

        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const key = `avatars/${req.user._id}.${ext}`;

        await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: buffer,
            ContentType: `image/${matches[1]}`,
        }));

        const avatarUrl = `https://${S3_BUCKET}.s3.amazonaws.com/${key}?t=${Date.now()}`;
        const userId = new ObjectId(req.user._id);
        await db.collection('users').updateOne({ _id: userId }, { $set: { avatarUrl } });

        const token = jwt.sign({
            _id: req.user._id, name: req.user.name, email: req.user.email,
            nickname: req.user.nickname, clubs: req.user.clubs, authType: req.user.authType, avatarUrl,
        }, 'supo-sect-ketyasdzaerfdsd', { expiresIn: '1w' });

        res.status(200).json({ token, avatarUrl });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Upload failed' });
    } finally {
        await client.close(true);
    }
});

app.get("/users", async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
        const usersAgg = await db.collection('users').aggregate([
            { $match: { active: true } },
            { $lookup: { from: 'clubs', localField: 'clubs', foreignField: '_id', as: 'clubs' } },
            { $project: { name: 1, nickname: 1, email: 1, 'clubs.active': 1, 'clubs.name': 1, 'clubs._id': 1 } },
            { $sort: { _id: -1 } },
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
        return res.status(500).json({
            error: 'Server Error',
        });
    } finally {
        await client.close(true);
    }
});

app.get("/club/users", clubAuthMiddleware, async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
        const users = await db.collection('users')
            .find({ clubs: new ObjectId(req.user._id), active: true })
            .project({ name: 1, nickname: 1, email: 1 });
        return res.status(200).json({
            items: await users.toArray(),
        });
    } catch (e) {
        console.error(e?.message)
        return res.status(500).json({
            error: 'Server Error',
        });
    } finally {
        await client.close(true);
    }
});

app.get("/user/clubs", userAuthMiddleware, async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
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
        return res.status(500).json({
            error: 'Server Error',
        });
    } finally {
        await client.close(true);
    }
});

app.get("/user/games", userAuthMiddleware, async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
        const rolesMap = {
            cit: 'Мир', maf: 'Маф', don: 'Дон', sher: 'Шер',
            // backward compatibility with old numeric roles
            0: 'Мир', 1: 'Маф', 2: 'Маф', 3: 'Дон', 4: 'Шер',
        }
        const gamesAgg = await db.collection('games').aggregate([
            { $match: { 'players.id': new ObjectId(req.user._id) } },
            { $lookup: { from: 'clubs', localField: 'club', foreignField: '_id', as: 'club' } },
            { $lookup: { from: 'rating_periods', localField: 'ratingPeriod', foreignField: '_id', as: 'ratingPeriod' } },
            { $unwind: '$club' },
            { $unwind: '$ratingPeriod' },
            { $project: { players: 1, winState: 1, votings: 1, createdAt: 1, club: '$club.name', ratingPeriod: '$ratingPeriod.name' } },
            { $sort: { _id: -1 } },
        ]);
        let games = await gamesAgg.toArray();

        games = games.map(game => {
            const { points, player, supportFivePoints, bonus, isWinner, winner } = calculateRating(game, req.user._id);

            return {
                id: game._id,
                role: rolesMap[player.role],
                supportFivePoints: isFirstDie(player) ? supportFivePoints : '-',
                bonus: bonus || '-',
                winner,
                createdAt: game.createdAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
                club: game.club,
                ratingPeriod: game.ratingPeriod,
                isWinner,
                points,
            }
        });
        return res.status(200).json({
            items: games,
        });
    } catch (e) {
        console.error(e?.message)
        return res.status(500).json({
            error: 'Server Error',
        });
    } finally {
        await client.close(true);
    }
});

app.post("/club/rating-period", clubAuthMiddleware, async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
        const { name } = req.body;
        await db.collection('rating_periods')
            .insertOne({ name, club: new ObjectId(req.user._id) });
        return res.status(200).json({
            status: 'Success',
        });
    } catch (e) {
        console.error(e?.message)
        return res.status(500).json({
            error: 'Server Error',
        });
    } finally {
        await client.close(true);
    }
});

app.get("/club/rating-periods", allAuthMiddleware, async (req, res, next) => {
    const { db, client } = await getMongoDataClient();
    try {
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
        return res.status(200).json({ items });
    } catch (e) {
        console.error(e?.message)
        return res.status(500).json({
            error: 'Server Error',
        });
    } finally {
        await client.close(true);
    }
});

app.get("/", async (req, res, next) => {
    return "Hello world!";
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

// Backward compatibility: convert old numeric roles to new string roles
function pct(a, b) {
    return Math.round((a / b) * 1000) / 10;
}

function normalizeRole(role) {
    const legacyMap = { 0: 'cit', 1: 'maf', 2: 'maf', 3: 'don', 4: 'sher' };
    return typeof role === 'number' ? legacyMap[role] : role;
}

function isFirstDie(player) {
    return player.killed === 1;
}
function isMafia(player) {
    const role = normalizeRole(player.role);
    return role === 'maf' || role === 'don';
}
function isDon(player) {
    return normalizeRole(player.role) === 'don';
}
function isSheriff(player) {
    return normalizeRole(player.role) === 'sher';
}
function isCitizen(player) {
    return normalizeRole(player.role) === 'cit';
}
function isGood(player) {
    const role = normalizeRole(player.role);
    return role === 'cit' || role === 'sher';
}
function isWinner(player, game) {
    return game.winState === 'mafia' ? isMafia(player) : isGood(player);
}

function has4Warnings(player) {
    return player.warnings === 4;
}

function getSupportFivePoints(player, mafiaPlayers) {
    return (player.bestTurn || []).reduce((acc, guess) => {
        if (typeof guess === 'object' && guess !== null) {
            const isActuallyMafia = mafiaPlayers.includes(guess.n);
            if (guess.color === 'black') {
                acc += isActuallyMafia ? 0.2 : -0.2;
            } else if (guess.color === 'red') {
                acc += !isActuallyMafia ? 0.1 : -0.1;
            }
        }
        return Math.round(acc * 100) / 100;
    }, 0);
}

function getPlayer(game, userId) {
    return game.players.find(player => player.id?.toString() === String(userId));
}

function getMafiaPlayers(game) {
    const mafiaPlayers = [];
    game.players.forEach((player, i) => {
        if (isMafia(player)) {
            mafiaPlayers.push(i + 1);
        }
    });
    return mafiaPlayers;
}

function calculateRating(game, userId) {
    const mafiaPlayers = getMafiaPlayers(game);
    const player = getPlayer(game, userId);
    const supportFivePoints = getSupportFivePoints(player, mafiaPlayers);
    const bonus = player.bonusPoints || 0;
    const winner = game.winState === 'mafia' ? 'Маф' : 'Мир';
    const _isWinner = isWinner(player, game);
    const has4Warns = has4Warnings(player);
    const points = Math.round(((_isWinner ? 1 : 0) + (has4Warns ? -0.3 : 0)) * 100) / 100;
    return { points, mafiaPlayers, player, supportFivePoints, bonus, isWinner: _isWinner, winner };
}

function getLast12Months() {
    const monthNames = {
        1: 'Cіч',
        2: 'Лют',
        3: 'Бер',
        4: 'Кві',
        5: 'Тра',
        6: 'Чер',
        7: 'Лип',
        8: 'Сер',
        9: 'Вер',
        10: 'Жов',
        11: 'Лис',
        12: 'Гру',
    }
    const nums = [];
    const names = [];
    const date = new Date();

    for (let i = 0; i < 12; i++) {
        names.unshift(monthNames[date.getMonth() + 1]);
        nums.unshift(date.getMonth() + 1);
        date.setMonth(date.getMonth() - 1);
    }

    return [nums, names];
}

exports.handler = serverless(app);