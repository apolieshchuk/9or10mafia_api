/**
 * Calendar dates for the app are always interpreted in America/Vancouver (PST/PDT).
 * Avoid `new Date('YYYY-MM-DD')` — that is UTC midnight and shifts the calendar day in Pacific time.
 */

const TZ = 'America/Vancouver';

const dtfYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

function vancouverYmdKey(ms) {
    const parts = dtfYmd.formatToParts(new Date(ms));
    const y = parts.find((p) => p.type === 'year').value;
    const m = parts.find((p) => p.type === 'month').value;
    const d = parts.find((p) => p.type === 'day').value;
    return `${y}-${m}-${d}`;
}

/** @returns {string} YYYY-MM-DD for that instant in Vancouver */
function utcDateToVancouverYmd(date) {
    if (!date || !(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return vancouverYmdKey(date.getTime());
}

/**
 * First millisecond of that calendar day in Vancouver.
 * @param {string} ymd YYYY-MM-DD
 * @returns {Date|null}
 */
function vancouverYmdToUtcDate(ymd) {
    if (!ymd || typeof ymd !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
    if (!m) return null;
    const Y = parseInt(m[1], 10);
    const M = parseInt(m[2], 10);
    const D = parseInt(m[3], 10);
    const target = `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;

    let lo = Date.UTC(Y, M - 1, D) - 72 * 3600000;
    let hi = Date.UTC(Y, M - 1, D) + 72 * 3600000;
    for (let i = 0; i < 64; i++) {
        const mid = Math.floor((lo + hi) / 2);
        const k = vancouverYmdKey(mid);
        if (k < target) lo = mid + 1;
        else hi = mid;
    }
    if (vancouverYmdKey(lo) !== target) {
        return null;
    }
    while (lo > 0 && vancouverYmdKey(lo - 1) === target) lo -= 1;
    return new Date(lo);
}

/** @returns {string} today's calendar date YYYY-MM-DD in Vancouver */
function vancouverTodayYmd() {
    return vancouverYmdKey(Date.now());
}

/** Add calendar days to YYYY-MM-DD (naive month math on parts, good for short offsets). */
function addDaysToYmd(ymd, days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
    if (!m) return ymd;
    const base = vancouverYmdToUtcDate(ymd.trim());
    if (!base) return ymd;
    const t = new Date(base.getTime() + days * 86400000);
    return utcDateToVancouverYmd(t);
}

/**
 * API body: empty, ISO string, or YYYY-MM-DD from <input type="date">.
 * @returns {Date|null}
 */
function parseScheduledDateInput(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val.trim())) {
        return vancouverYmdToUtcDate(val.trim());
    }
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = {
    TZ,
    utcDateToVancouverYmd,
    vancouverYmdToUtcDate,
    vancouverTodayYmd,
    addDaysToYmd,
    parseScheduledDateInput,
};
