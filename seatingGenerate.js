'use strict';

function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/** Перестановка слотів 0..9 на місця 1..10; слот i не отримує місце з usedSeatsPerSlot[i]. */
function findPermutationNoRepeatSeatForSlot(usedSeatsPerSlot) {
    const n = 10;
    const result = new Array(n);
    const taken = new Set();

    function dfs(i) {
        if (i === n) return true;
        const candidates = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(
            (s) => !taken.has(s) && !usedSeatsPerSlot[i].has(s)
        );
        shuffleInPlace(candidates);
        for (const seat of candidates) {
            taken.add(seat);
            result[i] = seat;
            if (dfs(i + 1)) return true;
            taken.delete(seat);
        }
        return false;
    }

    return dfs(0) ? result : null;
}

function tryRandomSeatAssignment(usedSeatsPerSlot, maxTries) {
    for (let t = 0; t < maxTries; t++) {
        const order = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        shuffleInPlace(order);
        let ok = true;
        for (let i = 0; i < 10; i++) {
            if (usedSeatsPerSlot[i].has(order[i])) {
                ok = false;
                break;
            }
        }
        if (ok) return order.slice();
    }
    return null;
}

/**
 * @param {{ userIds: string[] }[]} slots довжина 10
 * @param {number} numGames
 */
function generateSeatingByGame(slots, numGames) {
    const out = {};
    const usedSeatsPerSlot = Array.from({ length: 10 }, () => new Set());
    let relaxedConstraints = false;

    for (let g = 1; g <= numGames; g++) {
        let perm =
            tryRandomSeatAssignment(usedSeatsPerSlot, 400) ||
            findPermutationNoRepeatSeatForSlot(usedSeatsPerSlot);

        if (!perm) {
            relaxedConstraints = true;
            const order = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            shuffleInPlace(order);
            perm = order;
        }

        const gameSeats = {};
        for (let i = 0; i < 10; i++) {
            gameSeats[String(perm[i])] = { userIds: [...slots[i].userIds] };
        }
        out[String(g)] = gameSeats;
        for (let i = 0; i < 10; i++) {
            usedSeatsPerSlot[i].add(perm[i]);
        }
    }

    return { seatingByGame: out, relaxedConstraints };
}

/**
 * Будує розсадку з документа турніру (participants з БД).
 * @returns {{ seatingByGame: object, relaxedConstraints: boolean } | { error: string }}
 */
function seatingFromTournamentDocument(tournament) {
    const parts = tournament.participants || [];
    if (parts.length !== 10) {
        return { error: 'Потрібно рівно 10 рядків учасників у турнірі' };
    }
    const slots = parts.map((p) => ({
        userIds: (p.userIds || []).map((id) => String(id)).filter(Boolean),
    }));
    if (slots.some((s) => s.userIds.length < 1)) {
        return { error: 'У кожному рядку має бути хоча б один учасник' };
    }
    const numGames = Math.max(1, Number(tournament.numGames) || 1);
    return generateSeatingByGame(slots, numGames);
}

function idStr(x) {
    if (x == null) return '';
    return x && typeof x.toString === 'function' ? x.toString() : String(x);
}

/** Та сама «група» за складом id (порядок у масиві не важливий). */
function sameParticipantGroup(cellUserIds, rowUserIds) {
    const a = new Set((cellUserIds || []).map(idStr));
    const b = new Set((rowUserIds || []).map(idStr));
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

/**
 * Оновлює розсадку після зміни списку учасників: кожна комірка, що збігалася зі старим рядком i, отримує newParticipants[i].
 * Один прохід по комірках — коректно для обміну місцями рядків.
 * @param {Array<{ userIds?: unknown[] }>} oldParticipants документ з БД до оновлення
 * @param {Array<{ userIds?: unknown[] }>} newParticipants після normalizeParticipantUserIds
 * @param {object} seatingByGame
 */
function patchSeatingAfterParticipantUpdate(oldParticipants, newParticipants, seatingByGame) {
    if (!seatingByGame || typeof seatingByGame !== 'object') return null;
    const n = Math.min(oldParticipants.length, newParticipants.length);
    const out = {};
    for (const [gk, seats] of Object.entries(seatingByGame)) {
        if (!seats || typeof seats !== 'object') {
            out[gk] = seats;
            continue;
        }
        out[gk] = {};
        for (const [sk, cell] of Object.entries(seats)) {
            const uids = cell && Array.isArray(cell.userIds) ? cell.userIds : [];
            let next = uids.map(idStr);
            for (let i = 0; i < n; i++) {
                const oldRow = oldParticipants[i];
                const newRow = newParticipants[i];
                if (!oldRow || !newRow) continue;
                if (sameParticipantGroup(uids, oldRow.userIds)) {
                    next = (newRow.userIds || []).map(idStr);
                    break;
                }
            }
            out[gk][sk] = { userIds: next };
        }
    }
    return out;
}

module.exports = {
    generateSeatingByGame,
    seatingFromTournamentDocument,
    patchSeatingAfterParticipantUpdate,
};
