// Node 21+: `buffer` no longer exports SlowBuffer; jwa (jsonwebtoken) pulls buffer-equal-constant-time
// which reads SlowBuffer.prototype at load time → TypeError without this.
(function polyfillSlowBuffer() {
  try {
    const buf = require('buffer');
    if (buf.SlowBuffer == null && buf.Buffer) {
      buf.SlowBuffer = buf.Buffer;
    }
  } catch (_) { /* ignore */ }
})();

const serverless = require("serverless-http");
const express = require("express");
const app = express();
const cors = require('cors')
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require("bcryptjs");
const { clubAuthMiddleware, userAuthMiddleware, allAuthMiddleware, tryOptionalAuthUser } = require('./auth.middleware');
const jwt = require("jsonwebtoken");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const {
    parseScheduledDateInput,
    vancouverTodayYmd,
    vancouverYmdToUtcDate,
    addDaysToYmd,
    utcDateToVancouverYmd,
} = require('./vancouverDate');
const { seatingFromTournamentDocument } = require('./seatingGenerate');

/** YouTube / YouTube Music / short links only; порожній рядок = скинути кастомне посилання */
function normalizeYoutubeUrlInput(raw) {
    if (raw == null || typeof raw !== 'string') return '';
    const s = raw.trim().slice(0, 512);
    if (!s) return '';
    let urlStr = s;
    if (!/^https?:\/\//i.test(urlStr)) urlStr = `https://${urlStr}`;
    let u;
    try {
        u = new URL(urlStr);
    } catch {
        return '';
    }
    const host = u.hostname.toLowerCase();
    const hostNoWww = host.startsWith('www.') ? host.slice(4) : host;
    const allowed =
        hostNoWww === 'youtu.be' ||
        hostNoWww === 'youtube.com' ||
        hostNoWww === 'm.youtube.com' ||
        hostNoWww === 'music.youtube.com' ||
        hostNoWww.endsWith('.youtube.com');
    if (!allowed) return '';
    return u.href;
}

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
                const role = normalizeRole(player.role);
                if (role === 'maf') {
                    usersStats[user._id].mafiaGames++;
                    usersStats[user._id].mafiaWins += isWinner ? 1 : 0;
                    usersStats[user._id].mafiaWinsRate = pct(usersStats[user._id].mafiaWins, usersStats[user._id].mafiaGames);
                } else if (role === 'don') {
                    usersStats[user._id].donGames++;
                    usersStats[user._id].donWins += isWinner ? 1 : 0;
                    usersStats[user._id].donWinsRate = pct(usersStats[user._id].donWins, usersStats[user._id].donGames);
                } else if (role === 'sher') {
                    usersStats[user._id].sheriffGames++;
                    usersStats[user._id].sheriffWins += isWinner ? 1 : 0;
                    usersStats[user._id].sheriffWinsRate = pct(usersStats[user._id].sheriffWins, usersStats[user._id].sheriffGames);
                } else if (role === 'cit') {
                    usersStats[user._id].citizenGames++;
                    usersStats[user._id].citizenWins += isWinner ? 1 : 0;
                    usersStats[user._id].citizenWinsRate = pct(usersStats[user._id].citizenWins, usersStats[user._id].citizenGames);
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
    const yearAgo = new Date();
    yearAgo.setDate(1);
    yearAgo.setMonth(yearAgo.getMonth() - 11);
    yearAgo.setHours(0, 0, 0, 0);
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
        const todayVancouver = vancouverTodayYmd();
        const lastGame = await db.collection('games').findOne(
            { club: clubId },
            { sort: { createdAt: -1 } }
        );
        if (!lastGame) return res.status(200).json({ players: [] });
        const gameDay = lastGame.createdAt
            ? utcDateToVancouverYmd(new Date(lastGame.createdAt))
            : '';
        if (!gameDay || gameDay !== todayVancouver) {
            return res.status(200).json({ players: [] });
        }

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
        const isClub = req.user.authType === 'Клуб';

        await db.collection(isClub ? 'clubs' : 'users').updateOne(
            { _id: userId },
            { $set: { avatarUrl } },
        );

        const tokenPayload = isClub
            ? {
                _id: req.user._id,
                name: req.user.name,
                email: req.user.email,
                nickname: req.user.nickname || req.user.name,
                authType: req.user.authType,
                avatarUrl,
            }
            : {
                _id: req.user._id,
                name: req.user.name,
                email: req.user.email,
                nickname: req.user.nickname,
                clubs: req.user.clubs,
                authType: req.user.authType,
                avatarUrl,
            };

        const token = jwt.sign(tokenPayload, 'supo-sect-ketyasdzaerfdsd', { expiresIn: '1w' });

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

// --- Tournaments ---

function oidStr(x) {
    return x && x.toString ? x.toString() : String(x);
}

function parseObjectId(id) {
    try {
        return new ObjectId(id);
    } catch {
        return null;
    }
}

function userInTournamentParticipants(userId, tournament) {
    const uid = oidStr(userId);
    return (tournament.participants || []).some((p) =>
        (p.userIds || []).some((x) => oidStr(x) === uid)
    );
}

function userIdInSeatingByGame(seatingByGame, userId) {
    const uid = oidStr(userId);
    if (!seatingByGame || typeof seatingByGame !== 'object') return false;
    for (const seats of Object.values(seatingByGame)) {
        if (!seats || typeof seats !== 'object') continue;
        for (const cell of Object.values(seats)) {
            const ids = (cell && cell.userIds) || [];
            for (const x of ids) {
                if (oidStr(x) === uid) return true;
            }
        }
    }
    return false;
}

/** Усі userId, що з’являються в розсадці хоча б в одній грі (основні + запасні за столом). */
function userIdsInSeatingByGame(seatingByGame) {
    const set = new Set();
    if (!seatingByGame || typeof seatingByGame !== 'object') return set;
    for (const seats of Object.values(seatingByGame)) {
        if (!seats || typeof seats !== 'object') continue;
        for (const cell of Object.values(seats)) {
            if (!cell?.userIds) continue;
            for (const oid of cell.userIds) {
                const id = oidStr(oid);
                if (id) set.add(id);
            }
        }
    }
    return set;
}

/** Підтримка / публічний список: учасник з анкети або лише в розсадці (наприклад опціональний партнер). */
function userInTournamentCheerEligible(userId, tournament) {
    if (userInTournamentParticipants(userId, tournament)) return true;
    return userIdsInSeatingByGame(tournament.seatingByGame).has(oidStr(userId));
}

async function enrichParticipantSlotsWithSeatingOnlyUsers(db, tournament, slots) {
    const present = new Set();
    for (const s of slots) {
        for (const p of s.players || []) {
            if (p?.id) present.add(String(p.id));
        }
    }
    const seatingIds = userIdsInSeatingByGame(tournament.seatingByGame);
    const missing = [...seatingIds].filter((id) => !present.has(id));
    if (!missing.length) return slots;
    const oids = missing.map(parseObjectId).filter(Boolean);
    const users = oids.length
        ? await db
              .collection('users')
              .find({ _id: { $in: oids } }, { projection: { nickname: 1, name: 1, avatarUrl: 1 } })
              .toArray()
        : [];
    const byId = Object.fromEntries(users.map((u) => [u._id.toString(), u]));
    let maxSeat = slots.reduce((m, s) => Math.max(m, Number(s.seatIndex) || 0), 0);
    const extra = missing.map((id) => {
        maxSeat += 1;
        const u = byId[id];
        return {
            seatIndex: maxSeat,
            players: [
                {
                    id,
                    nickname: (u && (u.nickname || u.name)) || 'Учасник',
                    avatarUrl: (u && u.avatarUrl) || null,
                },
            ],
        };
    });
    return [...slots, ...extra];
}

async function canReadTournament(tournament, user) {
    if (user.authType === 'Клуб' && oidStr(tournament.club) === oidStr(user._id)) return true;
    if (user.authType === 'Учасник') {
        if (userInTournamentParticipants(user._id, tournament)) return true;
        if (userIdInSeatingByGame(tournament.seatingByGame, user._id)) return true;
    }
    return false;
}

function normalizeParticipantUserIds(participants) {
    if (!Array.isArray(participants)) return [];
    const out = [];
    for (const p of participants) {
        const raw = p.userIds || [];
        if (raw.length < 1 || raw.length > 2) continue;
        const ids = [];
        let ok = true;
        for (const id of raw) {
            const o = parseObjectId(id);
            if (!o) {
                ok = false;
                break;
            }
            ids.push(o);
        }
        if (ok) out.push({ userIds: ids });
    }
    return out;
}

function gameShouldRedact(tournament, gameIndex) {
    const n = tournament.numGames;
    const half = Math.floor(n / 2);
    return tournament.hideResultsAfterHalf && tournament.status !== 'completed' && gameIndex > half;
}

/** Найменший номер гри 1..numGames без збереженого результату (для «Діюча гра»). Індекси з БД нормалізуємо через Number. */
function computeNextTournamentGameIndex(tournament, gamesDocs) {
    if (!tournament || tournament.status !== 'in_progress') return null;
    const numGames = Number(tournament.numGames) || 0;
    if (numGames < 1) return null;
    const saved = new Set(
        (gamesDocs || [])
            .map((g) => Number(g.gameIndex))
            .filter((i) => Number.isFinite(i) && i >= 1)
    );
    if (saved.size >= numGames) return null;
    for (let i = 1; i <= numGames; i++) {
        if (!saved.has(i)) return i;
    }
    return null;
}

function normalizeSavedGameIndicesList(gamesDocs) {
    return (gamesDocs || [])
        .map((g) => Number(g.gameIndex))
        .filter((i) => Number.isFinite(i) && i >= 1)
        .sort((a, b) => a - b);
}

function aggregateTournamentStandings(games, tournament) {
    const stats = {};
    for (const game of games) {
        if (gameShouldRedact(tournament, game.gameIndex)) continue;
        const seen = new Set();
        for (const pl of game.players || []) {
            if (!pl.id) continue;
            const uid = oidStr(pl.id);
            if (seen.has(uid)) continue;
            seen.add(uid);
            const { points, supportFivePoints, bonus, player } = calculateRating(game, uid);
            if (!player) continue;
            if (!stats[uid]) {
                stats[uid] = { userId: uid, pointsSum: 0, supportFiveSum: 0, bonusSum: 0, gamesPlayed: 0 };
            }
            const op5Guesses = (player.bestTurn || []).filter((g) => typeof g === 'object' && g !== null && g.color);
            const s5 = isFirstDie(player) && op5Guesses.length > 0 ? supportFivePoints : 0;
            stats[uid].pointsSum = Math.round((stats[uid].pointsSum + points) * 100) / 100;
            stats[uid].supportFiveSum = Math.round((stats[uid].supportFiveSum + s5) * 100) / 100;
            stats[uid].bonusSum = Math.round((stats[uid].bonusSum + bonus) * 10) / 10;
            stats[uid].gamesPlayed += 1;
        }
    }
    return Object.values(stats).map((s) => ({
        ...s,
        total: Math.round((s.pointsSum + s.supportFiveSum + s.bonusSum) * 100) / 100,
    }));
}

app.post('/club/tournament', clubAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const clubId = new ObjectId(req.user._id);
        const { name, numGames, scheduledDate, participants, hideResultsAfterHalf, publicDescription, youtubeUrl } = req.body;
        if (!name || !numGames || numGames < 1) {
            return res.status(422).json({ error: 'name and numGames required' });
        }
        const doc = {
            club: clubId,
            name: String(name),
            numGames: Number(numGames),
            scheduledDate: parseScheduledDateInput(scheduledDate),
            status: 'draft',
            participants: normalizeParticipantUserIds(participants || []),
            publicDescription: typeof publicDescription === 'string' ? publicDescription.slice(0, 12000) : '',
            youtubeUrl: normalizeYoutubeUrlInput(youtubeUrl),
            hideResultsAfterHalf: Boolean(hideResultsAfterHalf),
            seatingByGame: null,
            winnerUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const r = await db.collection('tournaments').insertOne(doc);
        return res.status(200).json({ id: r.insertedId.toString() });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

app.put('/club/tournament/:id', clubAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const tid = parseObjectId(req.params.id);
        if (!tid) return res.status(422).json({ error: 'Invalid id' });
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || oidStr(tournament.club) !== oidStr(req.user._id)) {
            return res.status(404).json({ error: 'Not found' });
        }
        const maxIdx = await db.collection('tournament_games').find({ tournament: tid }).sort({ gameIndex: -1 }).limit(1).toArray();
        const maxSaved = maxIdx[0]?.gameIndex || 0;
        const { name, numGames, scheduledDate, participants, hideResultsAfterHalf, publicDescription, youtubeUrl } = req.body;
        const update = { updatedAt: new Date() };
        if (name !== undefined) update.name = String(name);
        if (scheduledDate !== undefined) {
            update.scheduledDate = parseScheduledDateInput(scheduledDate);
        }
        if (publicDescription !== undefined) {
            update.publicDescription = typeof publicDescription === 'string' ? publicDescription.slice(0, 12000) : '';
        }
        if (youtubeUrl !== undefined) {
            update.youtubeUrl = normalizeYoutubeUrlInput(youtubeUrl);
        }
        if (hideResultsAfterHalf !== undefined) update.hideResultsAfterHalf = Boolean(hideResultsAfterHalf);
        if (participants !== undefined) update.participants = normalizeParticipantUserIds(participants);
        if (numGames !== undefined) {
            const ng = Number(numGames);
            if (ng < maxSaved) {
                return res.status(422).json({ error: `numGames must be >= ${maxSaved}` });
            }
            update.numGames = ng;
        }
        await db.collection('tournaments').updateOne({ _id: tid }, { $set: update });
        return res.status(200).json({ data: 'Success' });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

app.post('/club/tournament/:id/start', clubAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const tid = parseObjectId(req.params.id);
        if (!tid) return res.status(422).json({ error: 'Invalid id' });
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || oidStr(tournament.club) !== oidStr(req.user._id)) {
            return res.status(404).json({ error: 'Not found' });
        }
        if (tournament.status !== 'draft') {
            return res.status(422).json({ error: 'Tournament already started or completed' });
        }
        await db.collection('tournaments').updateOne(
            { _id: tid },
            { $set: { status: 'in_progress', updatedAt: new Date() } }
        );
        return res.status(200).json({ data: 'Success' });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

app.post('/club/tournament/:id/complete', clubAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const tid = parseObjectId(req.params.id);
        if (!tid) return res.status(422).json({ error: 'Invalid id' });
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || oidStr(tournament.club) !== oidStr(req.user._id)) {
            return res.status(404).json({ error: 'Not found' });
        }
        const n = tournament.numGames;
        const games = await db.collection('tournament_games').find({ tournament: tid }).toArray();
        const idxSet = new Set(games.map((g) => g.gameIndex));
        for (let i = 1; i <= n; i++) {
            if (!idxSet.has(i)) {
                return res.status(422).json({ error: 'Not all games saved' });
            }
        }
        const standings = aggregateTournamentStandings(games, { ...tournament, status: 'completed' });
        standings.sort((a, b) => b.total - a.total);
        const winnerUserId = standings[0] ? parseObjectId(standings[0].userId) : null;
        await db.collection('tournaments').updateOne(
            { _id: tid },
            { $set: { status: 'completed', winnerUserId, completedAt: new Date(), updatedAt: new Date() } }
        );
        return res.status(200).json({ data: 'Success' });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

app.put('/club/tournament/:id/seating', clubAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const tid = parseObjectId(req.params.id);
        if (!tid) return res.status(422).json({ error: 'Invalid id' });
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || oidStr(tournament.club) !== oidStr(req.user._id)) {
            return res.status(404).json({ error: 'Not found' });
        }
        const { seatingByGame } = req.body;
        if (!seatingByGame || typeof seatingByGame !== 'object') {
            return res.status(422).json({ error: 'seatingByGame required' });
        }
        await db.collection('tournaments').updateOne(
            { _id: tid },
            { $set: { seatingByGame, updatedAt: new Date() } }
        );
        return res.status(200).json({ data: 'Success' });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

/** Згенерувати розсадку і записати в турнір. Якщо в body є participants (10 рядків) — рахуємо з них (актуальна форма), інакше з БД. */
app.post('/club/tournament/:id/seating/generate', clubAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const tid = parseObjectId(req.params.id);
        if (!tid) return res.status(422).json({ error: 'Invalid id' });
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || oidStr(tournament.club) !== oidStr(req.user._id)) {
            return res.status(404).json({ error: 'Not found' });
        }
        const bodyParts = req.body && Array.isArray(req.body.participants) ? req.body.participants : null;
        let built;
        if (bodyParts && bodyParts.length === 10) {
            const normalized = bodyParts.map((p) => ({
                userIds: (Array.isArray(p.userIds) ? p.userIds : []).map((x) => String(x)).filter(Boolean),
            }));
            if (normalized.some((s) => s.userIds.length < 1)) {
                return res.status(422).json({ error: 'У кожному рядку має бути хоча б один учасник' });
            }
            built = seatingFromTournamentDocument({ ...tournament, participants: normalized });
        } else {
            built = seatingFromTournamentDocument(tournament);
        }
        if (built.error) {
            return res.status(422).json({ error: built.error });
        }
        await db.collection('tournaments').updateOne(
            { _id: tid },
            { $set: { seatingByGame: built.seatingByGame, updatedAt: new Date() } }
        );
        return res.status(200).json({
            data: 'Success',
            relaxedConstraints: built.relaxedConstraints,
        });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

app.post('/club/tournament-game', clubAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const clubId = new ObjectId(req.user._id);
        const { tournamentId, gameIndex, players, winState, votings } = req.body;
        const tid = parseObjectId(tournamentId);
        const k = Number(gameIndex);
        if (!tid || !k || k < 1) {
            return res.status(422).json({ error: 'tournamentId and gameIndex required' });
        }
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || oidStr(tournament.club) !== oidStr(clubId)) {
            return res.status(404).json({ error: 'Tournament not found' });
        }
        if (tournament.status !== 'in_progress') {
            return res.status(422).json({ error: 'Tournament not in progress' });
        }
        if (k > tournament.numGames) {
            return res.status(422).json({ error: 'gameIndex out of range' });
        }
        const existing = await db.collection('tournament_games').findOne({ tournament: tid, gameIndex: k });
        if (existing) {
            return res.status(422).json({ error: 'Game already saved' });
        }
        for (let i = 1; i < k; i++) {
            const prev = await db.collection('tournament_games').findOne({ tournament: tid, gameIndex: i });
            if (!prev) {
                return res.status(422).json({ error: `Save game ${i} first` });
            }
        }
        const bonusErr = assertTournamentGameBonusLimits(winState, players);
        if (bonusErr) {
            return res.status(422).json({ error: bonusErr });
        }
        await db.collection('tournament_games').insertOne({
            tournament: tid,
            gameIndex: k,
            club: clubId,
            players: players.map((player) => ({
                ...player,
                role: normalizeRole(player.role),
                id: player.id && new ObjectId(player.id),
            })),
            winState,
            votings,
            locked: true,
            createdAt: new Date(),
        });
        return res.status(200).json({ data: 'Success' });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

app.put('/club/tournament-game', clubAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const clubId = new ObjectId(req.user._id);
        const { tournamentId, gameIndex, players, winState, votings } = req.body;
        const tid = parseObjectId(tournamentId);
        const k = Number(gameIndex);
        if (!tid || !k || k < 1) {
            return res.status(422).json({ error: 'tournamentId and gameIndex required' });
        }
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || oidStr(tournament.club) !== oidStr(clubId)) {
            return res.status(404).json({ error: 'Tournament not found' });
        }
        if (tournament.status !== 'in_progress') {
            return res.status(422).json({ error: 'Можна редагувати ігри лише поки турнір триває' });
        }
        if (k > tournament.numGames) {
            return res.status(422).json({ error: 'gameIndex out of range' });
        }
        const existing = await db.collection('tournament_games').findOne({ tournament: tid, gameIndex: k });
        if (!existing) {
            return res.status(404).json({ error: 'Гру не знайдено' });
        }
        const bonusErr = assertTournamentGameBonusLimits(winState, players);
        if (bonusErr) {
            return res.status(422).json({ error: bonusErr });
        }
        await db.collection('tournament_games').updateOne(
            { tournament: tid, gameIndex: k },
            {
                $set: {
                    players: players.map((player) => ({
                        ...player,
                        role: normalizeRole(player.role),
                        id: player.id && new ObjectId(player.id),
                    })),
                    winState,
                    votings,
                    updatedAt: new Date(),
                },
            }
        );
        return res.status(200).json({ data: 'Success' });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

function serializeTournamentRow(t, extra = {}) {
    return {
        id: t._id.toString(),
        name: t.name,
        numGames: t.numGames,
        scheduledDate: t.scheduledDate,
        status: t.status,
        hideResultsAfterHalf: t.hideResultsAfterHalf,
        winnerUserId: t.winnerUserId ? t.winnerUserId.toString() : null,
        publicDescription: t.publicDescription != null ? String(t.publicDescription) : '',
        youtubeUrl: t.youtubeUrl != null && String(t.youtubeUrl).trim() ? String(t.youtubeUrl).trim() : '',
        participants: (t.participants || []).map((p) => ({
            userIds: (p.userIds || []).map((x) => x.toString()),
        })),
        seatingByGame: t.seatingByGame || null,
        clubId: t.club ? t.club.toString() : null,
        ...extra,
    };
}

/** Public landing: recent/upcoming scheduled tournaments only (no sensitive history). */
function isTournamentPubliclyViewable(tournament) {
    if (!tournament.scheduledDate) return false;
    const status = tournament.status;
    if (!['draft', 'in_progress', 'completed'].includes(status)) return false;
    const todayYmd = vancouverTodayYmd();
    const lo = vancouverYmdToUtcDate(addDaysToYmd(todayYmd, -30));
    const hiExcl = vancouverYmdToUtcDate(addDaysToYmd(todayYmd, 91));
    if (!lo || !hiExcl) return false;
    const s = tournament.scheduledDate;
    return s >= lo && s < hiExcl;
}

async function buildPublicParticipantSlots(db, tournament) {
    const parts = tournament.participants || [];
    const uniqStr = new Set();
    for (const p of parts) {
        for (const id of p.userIds || []) {
            uniqStr.add(oidStr(id));
        }
    }
    const oids = [...uniqStr].map(parseObjectId).filter(Boolean);
    const users = oids.length
        ? await db.collection('users').find({ _id: { $in: oids } }, { projection: { nickname: 1, name: 1, avatarUrl: 1 } }).toArray()
        : [];
    const byId = Object.fromEntries(users.map((u) => [u._id.toString(), u]));
    return parts.map((p, i) => {
        const players = (p.userIds || []).map((oid) => {
            const id = oidStr(oid);
            const u = byId[id];
            return {
                id,
                nickname: (u && (u.nickname || u.name)) || 'Учасник',
                avatarUrl: (u && u.avatarUrl) || null,
            };
        });
        return { seatIndex: i + 1, players };
    });
}

function serializeSeatingByGameForPublic(seatingByGame) {
    if (!seatingByGame || typeof seatingByGame !== 'object') return null;
    const out = {};
    for (const [gk, seats] of Object.entries(seatingByGame)) {
        if (!seats || typeof seats !== 'object') continue;
        out[gk] = {};
        for (const [sk, cell] of Object.entries(seats)) {
            out[gk][sk] = {
                userIds: (cell.userIds || []).map((x) => oidStr(x)),
            };
        }
    }
    return Object.keys(out).length ? out : null;
}

app.get('/tournaments', allAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        let items;
        if (req.user.authType === 'Клуб') {
            items = await db
                .collection('tournaments')
                .find({ club: new ObjectId(req.user._id) })
                .sort({ _id: -1 })
                .toArray();
        } else {
            const uid = parseObjectId(req.user._id);
            if (!uid) {
                return res.status(422).json({ error: 'Invalid user id' });
            }
            const byParticipants = await db
                .collection('tournaments')
                .find({ participants: { $elemMatch: { userIds: uid } } })
                .sort({ _id: -1 })
                .toArray();
            const seen = new Set(byParticipants.map((t) => t._id.toString()));
            const seatingCandidates = await db
                .collection('tournaments')
                .find({
                    seatingByGame: { $exists: true, $ne: null },
                    _id: { $nin: byParticipants.map((t) => t._id) },
                })
                .sort({ _id: -1 })
                .limit(400)
                .toArray();
            const fromSeating = seatingCandidates.filter((t) => userIdInSeatingByGame(t.seatingByGame, req.user._id));
            for (const t of fromSeating) {
                if (!seen.has(t._id.toString())) {
                    seen.add(t._id.toString());
                    byParticipants.push(t);
                }
            }
            byParticipants.sort((a, b) => (a._id < b._id ? 1 : a._id > b._id ? -1 : 0));
            items = byParticipants;
        }
        const withCounts = await Promise.all(
            items.map(async (t) => {
                const count = await db.collection('tournament_games').countDocuments({ tournament: t._id });
                return serializeTournamentRow(t, { gamesSaved: count });
            })
        );
        const winnerOids = [...new Set(withCounts.map((t) => t.winnerUserId).filter(Boolean))].map(parseObjectId).filter(Boolean);
        const winnerUsers = winnerOids.length
            ? await db.collection('users').find({ _id: { $in: winnerOids } }, { projection: { nickname: 1 } }).toArray()
            : [];
        const wnick = Object.fromEntries(winnerUsers.map((u) => [u._id.toString(), u.nickname || '']));
        const enriched = withCounts.map((t) => ({
            ...t,
            winnerNickname: t.winnerUserId ? wnick[t.winnerUserId] || null : null,
        }));
        return res.status(200).json({ items: enriched });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

app.get('/tournament/:id', allAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const tid = parseObjectId(req.params.id);
        if (!tid) return res.status(422).json({ error: 'Invalid id' });
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || !(await canReadTournament(tournament, req.user))) {
            return res.status(404).json({ error: 'Not found' });
        }
        const gamesSaved = await db.collection('tournament_games').find({ tournament: tid }).sort({ gameIndex: 1 }).toArray();
        const indices = normalizeSavedGameIndicesList(gamesSaved);
        const nextGameIndex = computeNextTournamentGameIndex(tournament, gamesSaved);
        let winnerNickname = null;
        if (tournament.winnerUserId) {
            const u = await db.collection('users').findOne({ _id: tournament.winnerUserId }, { projection: { nickname: 1 } });
            winnerNickname = u?.nickname || null;
        }
        return res.status(200).json({
            ...serializeTournamentRow(tournament),
            gamesSaved: gamesSaved.length,
            savedGameIndices: indices,
            nextGameIndex,
            winnerNickname,
        });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

app.get('/tournament/:id/games', allAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const tid = parseObjectId(req.params.id);
        if (!tid) return res.status(422).json({ error: 'Invalid id' });
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || !(await canReadTournament(tournament, req.user))) {
            return res.status(404).json({ error: 'Not found' });
        }
        const games = await db.collection('tournament_games').find({ tournament: tid }).sort({ gameIndex: 1 }).toArray();
        const items = games.map((g) => {
            const redact = gameShouldRedact(tournament, g.gameIndex);
            if (redact) {
                return {
                    id: g._id.toString(),
                    gameIndex: g.gameIndex,
                    hidden: true,
                    createdAt: g.createdAt,
                };
            }
            return {
                id: g._id.toString(),
                gameIndex: g.gameIndex,
                hidden: false,
                winState: g.winState,
                players: g.players,
                votings: g.votings,
                createdAt: g.createdAt,
            };
        });
        return res.status(200).json({ items });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

app.get('/tournament/:id/standings', allAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const tid = parseObjectId(req.params.id);
        if (!tid) return res.status(422).json({ error: 'Invalid id' });
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || !(await canReadTournament(tournament, req.user))) {
            return res.status(404).json({ error: 'Not found' });
        }
        const games = await db.collection('tournament_games').find({ tournament: tid }).sort({ gameIndex: 1 }).toArray();
        const raw = aggregateTournamentStandings(games, tournament);
        const userIds = [...new Set(raw.map((r) => r.userId))];
        const oids = userIds.map((id) => parseObjectId(id)).filter(Boolean);
        const users = await db.collection('users').find({ _id: { $in: oids } }).toArray();
        const nickById = Object.fromEntries(users.map((u) => [u._id.toString(), u.nickname || u.name || '']));
        const rows = raw
            .map((r) => ({
                ...r,
                nickname: nickById[r.userId] || r.userId,
            }))
            .sort((a, b) => b.total - a.total)
            .map((r, i) => ({ ...r, rank: i + 1 }));
        return res.status(200).json({ items: rows });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

/** Public: announced (draft) tournaments with a date in the next 14 days — hide once started (in_progress). */
app.get('/public/upcoming-tournaments', async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const todayYmd = vancouverTodayYmd();
        const windowStart = vancouverYmdToUtcDate(todayYmd);
        const upperExclusiveYmd = addDaysToYmd(todayYmd, 15);
        const windowEndExclusive = vancouverYmdToUtcDate(upperExclusiveYmd);

        const agg = await db.collection('tournaments').aggregate([
            {
                $match: {
                    scheduledDate: {
                        $gte: windowStart,
                        $lt: windowEndExclusive,
                        $ne: null,
                    },
                    status: 'draft',
                },
            },
            { $lookup: { from: 'clubs', localField: 'club', foreignField: '_id', as: 'clubDoc' } },
            { $unwind: { path: '$clubDoc', preserveNullAndEmptyArrays: true } },
            { $sort: { scheduledDate: 1 } },
            { $limit: 15 },
            {
                $project: {
                    _id: 0,
                    id: { $toString: '$_id' },
                    name: 1,
                    scheduledDate: 1,
                    numGames: 1,
                    status: 1,
                    clubName: { $ifNull: ['$clubDoc.name', ''] },
                },
            },
        ]);
        const items = await agg.toArray();

        const weekMs = 7 * 24 * 60 * 60 * 1000;
        const completedSince = new Date(Date.now() - weekMs);
        const completedCandidates = await db
            .collection('tournaments')
            .find({ status: 'completed', winnerUserId: { $ne: null } })
            .sort({ completedAt: -1, updatedAt: -1 })
            .limit(25)
            .toArray();
        let recentCompleted = null;
        for (const t of completedCandidates) {
            const endedAt = t.completedAt || t.updatedAt;
            if (!endedAt || endedAt < completedSince) continue;
            if (!isTournamentPubliclyViewable(t)) continue;
            const woid = parseObjectId(t.winnerUserId);
            if (!woid) continue;
            const winner = await db.collection('users').findOne(
                { _id: woid },
                { projection: { nickname: 1, name: 1, avatarUrl: 1 } }
            );
            const winnerNickname = winner ? (winner.nickname || winner.name || '').trim() : '';
            recentCompleted = {
                id: t._id.toString(),
                name: t.name || '',
                winnerNickname: winnerNickname || 'Переможець',
                winnerAvatarUrl: winner?.avatarUrl || null,
            };
            break;
        }

        return res.status(200).json({ items, recentCompleted });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

/** Public: tournament card + participant list (avatars) for landing / share links. */
app.get('/public/tournament/:id', async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const tid = parseObjectId(req.params.id);
        if (!tid) return res.status(422).json({ error: 'Invalid id' });
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || !isTournamentPubliclyViewable(tournament)) {
            return res.status(404).json({ error: 'Not found' });
        }
        const club = await db.collection('clubs').findOne({ _id: tournament.club }, { projection: { name: 1, avatarUrl: 1 } });
        const slots = await buildPublicParticipantSlots(db, tournament);
        const slotsMerged = await enrichParticipantSlotsWithSeatingOnlyUsers(db, tournament, slots);
        const slotsWithPlayers = slotsMerged.filter((s) => s.players && s.players.length > 0);

        const games = await db.collection('tournament_games').find({ tournament: tid }).sort({ gameIndex: 1 }).toArray();
        const nextGameIndex = computeNextTournamentGameIndex(tournament, games);
        const rawStandings = aggregateTournamentStandings(games, tournament);
        const standingIds = [...new Set(rawStandings.map((r) => r.userId))];
        const standingOids = standingIds.map(parseObjectId).filter(Boolean);
        const standingUsers = standingOids.length
            ? await db.collection('users').find({ _id: { $in: standingOids } }, { projection: { nickname: 1, name: 1, avatarUrl: 1 } }).toArray()
            : [];
        const standingById = Object.fromEntries(standingUsers.map((u) => [u._id.toString(), u]));
        const standingsRows = rawStandings
            .map((r) => {
                const u = standingById[r.userId];
                return {
                    userId: r.userId,
                    nickname: u ? (u.nickname || u.name || '') : r.userId,
                    avatarUrl: u?.avatarUrl || null,
                    pointsSum: r.pointsSum,
                    supportFiveSum: r.supportFiveSum,
                    bonusSum: r.bonusSum,
                    total: r.total,
                    gamesPlayed: r.gamesPlayed,
                };
            })
            .sort((a, b) => b.total - a.total)
            .map((r, i) => ({ ...r, rank: i + 1 }));

        return res.status(200).json({
            id: tournament._id.toString(),
            name: tournament.name,
            numGames: tournament.numGames,
            scheduledDate: tournament.scheduledDate,
            status: tournament.status,
            hideResultsAfterHalf: Boolean(tournament.hideResultsAfterHalf),
            clubId: tournament.club ? tournament.club.toString() : null,
            nextGameIndex,
            clubName: club?.name || '',
            clubAvatarUrl: club?.avatarUrl || null,
            publicDescription: tournament.publicDescription != null ? String(tournament.publicDescription) : '',
            youtubeUrl: tournament.youtubeUrl != null && String(tournament.youtubeUrl).trim()
                ? String(tournament.youtubeUrl).trim()
                : '',
            participantSlots: slotsWithPlayers,
            seatingByGame: serializeSeatingByGameForPublic(tournament.seatingByGame),
            standingsRows,
        });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

/** Публічна стрічка підтримки учасників турніру (без авторизації). */
app.get('/public/tournament/:id/cheers', async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const tid = parseObjectId(req.params.id);
        if (!tid) return res.status(422).json({ error: 'Invalid id' });
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || !isTournamentPubliclyViewable(tournament)) {
            return res.status(404).json({ error: 'Not found' });
        }
        const cheers = await db
            .collection('tournament_cheers')
            .find({ tournament: tid })
            .sort({ createdAt: -1 })
            .limit(400)
            .toArray();
        const userIds = new Set();
        for (const c of cheers) {
            userIds.add(oidStr(c.toUser));
            if (c.anonymous === false) {
                userIds.add(oidStr(c.fromUser));
            }
        }
        const oids = [...userIds].map(parseObjectId).filter(Boolean);
        const users = oids.length
            ? await db.collection('users').find({ _id: { $in: oids } }, { projection: { nickname: 1, name: 1, avatarUrl: 1 } }).toArray()
            : [];
        const byId = Object.fromEntries(users.map((u) => [u._id.toString(), u]));
        const foundUser = new Set(users.map((u) => u._id.toString()));
        const missingClubOids = oids.filter((o) => !foundUser.has(o.toString()));
        if (missingClubOids.length) {
            const clubs = await db
                .collection('clubs')
                .find({ _id: { $in: missingClubOids } }, { projection: { nickname: 1, name: 1, avatarUrl: 1 } })
                .toArray();
            for (const c of clubs) {
                byId[c._id.toString()] = c;
            }
        }
        const nick = (id) => {
            const u = byId[id];
            return u ? u.nickname || u.name || id : id;
        };
        const av = (id) => (byId[id] && byId[id].avatarUrl) || null;
        const items = cheers.map((c) => {
            const fid = oidStr(c.fromUser);
            const tidu = oidStr(c.toUser);
            const isAnon = c.anonymous !== false;
            const row = {
                id: c._id.toString(),
                message: c.message,
                createdAt: c.createdAt,
                anonymous: isAnon,
                toUser: { id: tidu, nickname: nick(tidu), avatarUrl: av(tidu) },
            };
            if (!isAnon) {
                row.fromUser = { id: fid, nickname: nick(fid), avatarUrl: av(fid) };
            } else {
                row.fromUser = null;
            }
            return row;
        });
        const countsByUserId = {};
        for (const c of cheers) {
            const k = oidStr(c.toUser);
            countsByUserId[k] = (countsByUserId[k] || 0) + 1;
        }
        const optionalViewer = tryOptionalAuthUser(req);
        const viewerId = optionalViewer && optionalViewer._id != null ? oidStr(optionalViewer._id) : '';
        const viewerHasCheered = Boolean(
            viewerId && cheers.some((c) => oidStr(c.fromUser) === viewerId)
        );
        return res.status(200).json({ items, countsByUserId, viewerHasCheered });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
    } finally {
        await client.close(true);
    }
});

/**
 * Одна підтримка на акаунт (клуб або учасник) на турнір.
 * Отримувач — у tournament.participants або в розсадці (seatingByGame); не можна підтримати себе.
 */
app.post('/tournament/:id/cheer', allAuthMiddleware, async (req, res) => {
    const { db, client } = await getMongoDataClient();
    try {
        const tid = parseObjectId(req.params.id);
        const { toUserId, message, anonymous } = req.body || {};
        const fromOid = parseObjectId(req.user._id);
        const toOid = parseObjectId(toUserId);
        const isAnonymous = anonymous !== false;
        if (!tid || !fromOid || !toOid) {
            return res.status(422).json({ error: 'Некоректні дані' });
        }
        const msg = String(message || '').trim();
        if (msg.length < 1) {
            return res.status(422).json({ error: 'Напишіть коротке побажання' });
        }
        if (msg.length > 220) {
            return res.status(422).json({ error: 'Повідомлення занадто довге (макс. 220 символів)' });
        }
        const tournament = await db.collection('tournaments').findOne({ _id: tid });
        if (!tournament || !isTournamentPubliclyViewable(tournament)) {
            return res.status(404).json({ error: 'Not found' });
        }
        if (!userInTournamentCheerEligible(toOid, tournament)) {
            return res.status(422).json({ error: 'Цей гравець не в списку учасників турніру' });
        }
        if (oidStr(fromOid) === oidStr(toOid)) {
            return res.status(422).json({ error: 'Не можна підтримати себе' });
        }
        const existing = await db.collection('tournament_cheers').findOne({ tournament: tid, fromUser: fromOid });
        if (existing) {
            return res.status(422).json({ error: 'Ви вже підтримали учасника в цьому турнірі' });
        }
        await db.collection('tournament_cheers').insertOne({
            tournament: tid,
            fromUser: fromOid,
            toUser: toOid,
            message: msg,
            anonymous: Boolean(isAnonymous),
            createdAt: new Date(),
        });
        return res.status(200).json({ data: 'ok' });
    } catch (e) {
        console.error(e?.message);
        return res.status(500).json({ error: 'Server Error' });
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

/** Tournament judge bonus caps (must match frontend NewGame BONUS_TOURNAMENT_*). */
function assertTournamentGameBonusLimits(winState, players) {
    const gameStub = { winState, players };
    for (const pl of players || []) {
        const raw = pl.bonusPoints;
        const b = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw);
        const bonus = Number.isFinite(b) ? b : 0;
        if (bonus < 0) return 'Недопустиме значення бонусних балів';
        const won = isWinner(pl, gameStub);
        if (won) {
            if (bonus > 0.8) return 'Бонус переможців у турнірі не більше 0.8';
        } else if (bonus > 0.5) {
            return 'Бонус програвшої команди у турнірі не більше 0.5';
        }
    }
    return null;
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