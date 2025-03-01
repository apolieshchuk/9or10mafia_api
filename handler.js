const serverless = require("serverless-http");
const express = require("express");
const app = express();
const cors = require('cors')
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require("bcryptjs");
const { clubAuthMiddleware, userAuthMiddleware, allAuthMiddleware } = require('./auth.middleware');
const jwt = require("jsonwebtoken");

app.use(cors())
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
        const gamesAgg = await db.collection('games').aggregate([
            { $match: { club: clubId, ratingPeriod: latestRatingPeriod._id  } },
            { $addFields: { usersId: { $map: { input: '$players', as: 'player', in: '$$player.id' } } }},
            { $unwind: '$usersId' },
            { $match: { 'usersId': { $ne: null } } },
            { $group: { _id: '$usersId', games: { $push: '$$ROOT' } } },
            { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
            { $unwind: '$user' },
            { $project: { games: 1, name: '$user.name', nickname: '$user.nickname' } },
        ]);
        let users = await gamesAgg.toArray();
        const usersStats = {};
        const defaultTotalStats = {
            totalGames: 0,
            citizensWins: 0,
            mafiaWins: 0,
        }
        const [mnthNums, mnthNames] = getLast12Months();

        const totalStats = mnthNums.reduce((acc, monthNum, i) => {
            const m = { ...defaultTotalStats, name: mnthNames[i] };
            acc.set(Number(monthNum), m);
            return acc;
        }, new Map());
        const calculatedGamesMap = {}
        for (let user of users) {
            const games = user.games;
            const totalGames = games.length;
            usersStats[user._id] = {
                id: user._id,
                name: user.name,
                nickname: user.nickname,
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
                bestTurn2_3: 0,
                bestTurn3_3: 0,
                firsDie: 0,
            }
            for (let game of games) {
                const { points, player, bestTurnGuess, isWinner, winner} = calculateRating(game, user._id);
                // Total stats
                const mnth = game.createdAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }).split('/')[0];
                if (!calculatedGamesMap[game._id]) { // ToDO if date < 12 months
                    const current = totalStats.get(Number(mnth));
                    const newMnth = {
                        ...current,
                        totalGames: current.totalGames + 1,
                        citizensWins: current.citizensWins + (winner === 'Мир' ? 1 : 0),
                        mafiaWins: current.mafiaWins + (winner === 'Маф' ? 1 : 0),
                    };
                    totalStats.set(Number(mnth), newMnth);
                   calculatedGamesMap[game._id] = true;
                }

                usersStats[user._id].points += points;
                usersStats[user._id].rating = usersStats[user._id].points / usersStats[user._id].totalGames * 100;
                if (bestTurnGuess === 2) {
                    usersStats[user._id].bestTurn2_3++;
                } else if (bestTurnGuess === 3) {
                    usersStats[user._id].bestTurn3_3++;
                }
                usersStats[user._id].totalWins += isWinner ? 1 : 0;
                usersStats[user._id].totalWinsRate = usersStats[user._id].totalWins / usersStats[user._id].totalGames * 100;
                if (isMafia(player)) {
                    usersStats[user._id].mafiaGames++;
                    usersStats[user._id].mafiaWins += isWinner ? 1 : 0;
                    usersStats[user._id].mafiaWinsRate = usersStats[user._id].mafiaWins / usersStats[user._id].mafiaGames * 100;
                } else if (isSheriff(player)) {
                    usersStats[user._id].sheriffGames++;
                    usersStats[user._id].sheriffWins += isWinner ? 1 : 0;
                    usersStats[user._id].sheriffWinsRate = usersStats[user._id].sheriffWins / usersStats[user._id].sheriffGames * 100;
                } else if (isGood(player)) {
                    usersStats[user._id].citizenGames++;
                    usersStats[user._id].citizenWins += isWinner ? 1 : 0;
                    usersStats[user._id].citizenWinsRate = usersStats[user._id].citizenWins / usersStats[user._id].citizenGames * 100;
                } else if (isDon(player)) {
                    usersStats[user._id].donGames++;
                    usersStats[user._id].donWins += isWinner ? 1 : 0;
                    usersStats[user._id].donWinsRate = usersStats[user._id].donWins / usersStats[user._id].donGames * 100;
                }
                usersStats[user._id].firsDie += isFirstDie(player) ? 1 : 0;
            }
        }
        const sortByRating = Object.values(usersStats).sort((a, b) => {
            if (b.rating !== a.rating) {
                return b.rating - a.rating
            }
            return b.totalGames - a.totalGames;
        });
        return res.status(200).json({
            players: sortByRating.map((player, i) => ({...player, rank: i + 1})),
            stats: [...totalStats],
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
                players: players.map(player => ({ ...player, id: player.id && new ObjectId(player.id) })),
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
            0: 'Мир',
            1: 'Маф',
            2: 'Маф',
            3: 'Дон',
            4: 'Шер'
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
            const { points, player, bestTurnGuess, isWinner, winner } = calculateRating(game, req.user._id);

            return {
                id: game._id,
                role: rolesMap[player.role],
                bestTurnGuess: isFirstDie(player) ? `${bestTurnGuess}/3` : '-',
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

function isFirstDie(player) {
    return player.killed === 1;
}
function isMafia(player) {
    return player.role === 1 || player.role === 2 || player.role === 3;
}
function isDon(player) {
    return player.role === 3;
}
function isSheriff(player) {
    return player.role === 4;
}
function isCitizen(player) {
    return player.role === 0;
}
function isGood(player) {
    return player.role === 0 || player.role === 4;
}
function isWinner(player, game) {
    return game.winState === 'mafia' ? (player.role === 1 || player.role === 2 || player.role === 3) : (player.role === 0 || player.role === 4);
}

function has4Warnings(player) {
    return player.warnings === 4;
}

function getBestTurnGuess(player, mafiaPlayers) {
    return (player.bestTurn || []).reduce((acc, n) => {
        if (mafiaPlayers.includes(n)) {
            acc++;
        }
        return acc
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
    const bestTurnGuess = getBestTurnGuess(player, mafiaPlayers);
    const winner = game.winState === 'mafia' ? 'Маф' : 'Мир';
    const _isWinner = isWinner(player, game);
    const has4Warns = has4Warnings(player);
    const points = (_isWinner ? 1 : 0) + (bestTurnGuess === 3 ? 0.7 : bestTurnGuess === 2 ? 0.5 : 0) + (has4Warns ? -0.3 : 0);
    return { points, mafiaPlayers, player, bestTurnGuess, isWinner: _isWinner, winner };
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