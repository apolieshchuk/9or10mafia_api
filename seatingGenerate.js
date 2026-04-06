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

module.exports = { generateSeatingByGame, seatingFromTournamentDocument };
