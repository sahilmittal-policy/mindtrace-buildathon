/* Pure scoring and storage helpers. No DOM references live in this file. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MindTraceEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const mean = (values) =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;

  const standardDeviation = (values) => {
    if (!values.length) return 0;
    const average = mean(values);
    return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
  };

  const round = (value) => Math.round(value * 10) / 10;

  function accuracyFor(metrics) {
    if (!metrics) return null;

    const rounds = Number(metrics.rounds);

    if (typeof metrics.accuracy === "number") {
      return clamp(metrics.accuracy, 0, 1);
    }

    if (typeof metrics.avgScore === "number") {
      return clamp(metrics.avgScore, 0, 1);
    }

    if (typeof metrics.correct === "number" && rounds > 0) {
      return clamp(metrics.correct / rounds, 0, 1);
    }

    return null;
  }

  function analyticsRows(sessions) {
    return sessions
      .map((session) => ({
        date: session.date,

        responseTime: session.games?.symbolMatch?.avgSeconds ?? null,
        symbolMatchAccuracy: accuracyFor(session.games?.symbolMatch),
        memoryAccuracy: accuracyFor(session.games?.memory),
        wordFillAccuracy: accuracyFor(session.games?.words),

        sleepHours: session.checkin?.sleepHours ?? null,
        sleepQuality: session.checkin?.sleepQuality ?? null,
        stress: session.checkin?.stress ?? null,
        mood: session.checkin?.mood ?? null,
        energy: session.checkin?.energy ?? null,

        caffeine:
          typeof session.checkin?.caffeine === "boolean"
            ? session.checkin.caffeine
              ? 1
              : 0
            : null
      }))
      .map((row) => {
        Object.keys(row).forEach((key) => {
          if (
            key !== "date"
            && row[key] !== null
            && !Number.isFinite(Number(row[key]))
          ) {
            row[key] = null;
          }
        });

        return row;
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  function rollingAverage(rows, metric, days = 7) {
    return rows.map((row, index) => {
      const currentDate = new Date(`${row.date}T12:00:00`);

      const values = rows
        .slice(0, index + 1)
        .filter((candidate) => {
          const candidateDate = new Date(`${candidate.date}T12:00:00`);
          const age = (currentDate - candidateDate) / 86400000;

          return (
            age >= 0
            && age < days
            && typeof candidate[metric] === "number"
          );
        })
        .map((candidate) => candidate[metric]);

      return values.length ? round(mean(values)) : null;
    });
  }

  function personalBaseline(rows, index, metric, window = 14) {
    const values = rows
      .slice(Math.max(0, index - window), index)
      .map((row) => row[metric])
      .filter((value) => typeof value === "number");

    if (!values.length) return null;

    return {
      mean: round(mean(values)),
      sd: round(standardDeviation(values)),
      count: values.length
    };
  }

  function deviationPercent(value, baseline) {
    if (
      typeof value !== "number"
      || !baseline
      || typeof baseline.mean !== "number"
      || baseline.mean === 0
    ) {
      return null;
    }

    return round(((value - baseline.mean) / baseline.mean) * 100);
  }

  function correlation(rows, xKey, yKey) {
    const pairs = rows.filter(
      (row) =>
        typeof row[xKey] === "number"
        && typeof row[yKey] === "number"
    );

    if (pairs.length < 5) {
      return { value: null, count: pairs.length };
    }

    const xMean = mean(pairs.map((row) => row[xKey]));
    const yMean = mean(pairs.map((row) => row[yKey]));

    const numerator = pairs.reduce(
      (sum, row) =>
        sum + (row[xKey] - xMean) * (row[yKey] - yMean),
      0
    );

    const xDistance = Math.sqrt(
      pairs.reduce(
        (sum, row) => sum + (row[xKey] - xMean) ** 2,
        0
      )
    );

    const yDistance = Math.sqrt(
      pairs.reduce(
        (sum, row) => sum + (row[yKey] - yMean) ** 2,
        0
      )
    );

    return {
      value:
        xDistance && yDistance
          ? round(numerator / (xDistance * yDistance))
          : null,
      count: pairs.length
    };
  }

  function sleepScore(hours, quality) {
    const distance = hours < 7 ? 7 - hours : hours > 8 ? hours - 8 : 0;
    const hoursComponent = clamp(100 - distance * 18, 0, 100);
    const qualityComponent = clamp(((quality - 1) / 4) * 100, 0, 100);

    return Math.round(hoursComponent * 0.6 + qualityComponent * 0.4);
  }

  function scoreSymbolMatch(metrics) {
    const rounds = Math.max(1, metrics.rounds || 0);
    const correct =
      typeof metrics.correct === "number"
        ? metrics.correct
        : Math.max(0, rounds - (metrics.skipped || 0));

    const accuracy = clamp(correct / rounds, 0, 1);
    const pace =
      typeof metrics.avgSeconds === "number"
        ? metrics.avgSeconds
        : 12;

    const speed = clamp(100 - (pace - 3) * 11, 0, 100);

    return {
      speed: clamp(speed * 0.62 + accuracy * 100 * 0.38, 0, 100),
      focus: clamp(
        accuracy * 100 * 0.7
          + speed * 0.3
          - (metrics.wrongTaps || 0) * 3
          - (metrics.skipped || 0) * 5,
        0,
        100
      )
    };
  }

  function scoreMemory(metrics) {
    const average =
      typeof metrics.avgScore === "number"
        ? metrics.avgScore
        : 0;

    return {
      memory: clamp(average * 100, 0, 100)
    };
  }

  function scoreWords(metrics) {
    const rounds = Math.max(1, metrics.rounds || 0);
    const accuracy = clamp((metrics.correct || 0) / rounds, 0, 1);
    const pace =
      typeof metrics.avgSeconds === "number"
        ? metrics.avgSeconds
        : 10;

    const timeScore = clamp(
      100 - Math.max(0, pace - 7) * 5,
      0,
      100
    );

    return {
      words: clamp(
        accuracy * 80
          + timeScore * 0.2
          - (metrics.skipped || 0) * 3,
        0,
        100
      )
    };
  }

  function calculateDomains(games) {
    const domains = {};

    if (games.symbolMatch) {
      Object.assign(domains, scoreSymbolMatch(games.symbolMatch));
    }

    if (games.memory) {
      Object.assign(domains, scoreMemory(games.memory));
    }

    if (games.words) {
      Object.assign(domains, scoreWords(games.words));
    }

    Object.keys(domains).forEach((key) => {
      domains[key] = round(domains[key]);
    });

    return domains;
  }

  function composite(domains) {
    const values = Object.values(domains).filter(
      (value) => typeof value === "number"
    );

    return values.length ? round(mean(values)) : null;
  }

  function getBaseline(sessions) {
    // Sessions 8 to 14 only. The first week is contaminated by practice
    // effects, and including it widens the band enough to hide real change.
    const window = sessions.slice(7, 14);
    const domains = {};

    ["speed", "focus", "memory", "words"].forEach((key) => {
      const values = window
        .map((session) => session.domains && session.domains[key])
        .filter((value) => typeof value === "number");

      if (values.length) {
        const sd = standardDeviation(values);

        domains[key] = {
          mean: mean(values),
          sd,
          halfWidth: Math.max(3.5, sd)
        };
      }
    });

    const composites = window
      .map((session) => session.composite)
      .filter((value) => typeof value === "number");

    if (composites.length) {
      const sd = standardDeviation(composites);

      domains.composite = {
        mean: mean(composites),
        sd,
        halfWidth: Math.max(3.5, sd)
      };
    }

    return {
      fromSession: 8,
      toSession: 14,
      domains
    };
  }

  function verdictFor(sessions, context) {
    const count = sessions.length;

    if (count < 15) {
      return {
        key: "building",
        label: "Building your picture",
        explanation: `Complete ${15 - count} more ${
          15 - count === 1 ? "session" : "sessions"
        } to begin your personal usual range.`
      };
    }

    const baseline = getBaseline(sessions);
    const latest = sessions[sessions.length - 1];
    const band = baseline.domains.composite;

    if (!band || !latest) {
      return {
        key: "building",
        label: "Building your picture",
        explanation: "Your personal range is still taking shape."
      };
    }

    const recent = sessions.slice(-3);

    const belowCount = recent.filter(
      (session) =>
        typeof session.composite === "number"
        && session.composite < band.mean - band.halfWidth
    ).length;

    const lowDomains = ["speed", "focus", "memory", "words"].filter((key) => {
      const entry = baseline.domains[key];
      const value = latest.domains && latest.domains[key];

      return (
        entry
        && typeof value === "number"
        && value < entry.mean - entry.halfWidth * 1.5
      );
    });

    const checkin = latest.checkin || {};
    const poorSleep =
      (checkin.sleepHours ?? 8) < 5.5
      || (checkin.sleepQuality ?? 3) <= 2;

    const highStress = (checkin.stress ?? 1) >= 4;

    const contextText =
      poorSleep || highStress
        ? "Sleep or stress may be part of this."
        : "Sleep and stress have been in their usual range, so those do not appear to explain it.";

    if (belowCount >= 2) {
      return {
        key: "flag",
        label: "Worth discussing",
        explanation: `${formatAreas(
          lowDomains
        )} are below your usual range across recent check-ins. ${contextText} This is not a medical diagnosis. Mention it at your next appointment.`
      };
    }

    if (
      typeof latest.composite === "number"
      && latest.composite < band.mean - band.halfWidth
    ) {
      return {
        key: "context",
        label: "A day with context",
        explanation:
          "Today's result is below your usual range, and sleep or stress may be influencing it. See how you feel after a more settled day."
      };
    }

    if (lowDomains.length) {
      return {
        key: "note",
        label: "Worth watching",
        explanation: `${formatAreas(
          lowDomains
        )} are a little below your usual range today. One day is only one day; keep checking in.`
      };
    }

    return {
      key: "good",
      label: "Within your usual range",
      explanation:
        "Today's result sits within the range you've built for yourself."
    };
  }

  function formatAreas(keys) {
    const labels = {
      speed: "Speed",
      focus: "Focus",
      memory: "Memory",
      words: "Words"
    };

    const areas = keys.map((key) => labels[key] || key);

    if (!areas.length) return "A few areas";
    if (areas.length === 1) return areas[0];
    if (areas.length === 2) return `${areas[0]} and ${areas[1]}`;

    return `${areas.slice(0, -1).join(", ")}, and ${
      areas[areas.length - 1]
    }`;
  }

  function currentStreak(sessions) {
    const days = new Set(sessions.map((session) => session.date));
    let cursor = new Date();
    let streak = 0;

    while (days.has(toDateKey(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    return streak;
  }

  function longestStreak(sessions) {
    const days = [...new Set(sessions.map((session) => session.date))].sort();
    let best = 0;
    let run = 0;
    let previous = null;

    days.forEach((date) => {
      const current = new Date(`${date}T12:00:00`);
      const prior = previous && new Date(`${previous}T12:00:00`);

      if (prior && (current - prior) / 86400000 === 1) {
        run += 1;
      } else {
        run = 1;
      }

      best = Math.max(best, run);
      previous = date;
    });

    return best;
  }

  function toDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }

  function daysSince(sessions) {
    if (!sessions.length) return 0;

    const dates = [...new Set(sessions.map((session) => session.date))].sort();
    const last = new Date(`${dates[dates.length - 1]}T12:00:00`);
    const now = new Date();

    now.setHours(12, 0, 0, 0);

    return Math.round((now - last) / 86400000);
  }

  function hadGap(sessions, gapDays) {
    const dates = [...new Set(sessions.map((session) => session.date))].sort();

    for (let index = 1; index < dates.length; index += 1) {
      const first = new Date(`${dates[index - 1]}T12:00:00`);
      const second = new Date(`${dates[index]}T12:00:00`);

      if ((second - first) / 86400000 > gapDays) {
        return true;
      }
    }

    return false;
  }

  function badgesFor(sessions) {
    const count = sessions.length;
    const best = longestStreak(sessions);

    const fullSets = sessions.filter(
      (session) => Object.keys(session.games || {}).length === 3
    ).length;

    const gamesTried = new Set();

    sessions.forEach((session) => {
      Object.keys(session.games || {}).forEach((key) => {
        gamesTried.add(key);
      });
    });

    const shortNight = sessions.some(
      (session) =>
        session.checkin
        && session.checkin.sleepHours < 5.5
    );

    const heavyDay = sessions.some(
      (session) =>
        session.checkin
        && session.checkin.stress >= 5
    );

    const lowMood = sessions.some(
      (session) =>
        session.checkin
        && session.checkin.mood <= 2
    );

    const notedSomething = sessions.some(
      (session) =>
        session.checkin
        && session.checkin.notes
        && session.checkin.notes.length > 0
    );

    const make = (
      key,
      name,
      detail,
      done,
      target,
      tier,
      cheer
    ) => ({
      key,
      name,
      detail,
      tier,
      unlocked: done >= target,
      progress: Math.max(
        0,
        Math.min(1, target ? done / target : 0)
      ),
      progressLabel: done >= target
        ? "Earned"
        : `${Math.floor(done)} of ${target}`,
      remaining: Math.max(0, target - done),
      cheer
    });

    return [
      make(
        "first",
        "First Step",
        "Your very first check-in",
        count,
        1,
        1,
        "Everything starts here."
      ),
      make(
        "set",
        "Full Set",
        "All three games in one day",
        fullSets,
        1,
        1,
        "Try all three in one sitting — it makes a fuller picture."
      ),
      make(
        "explorer",
        "Curious Sort",
        "Tried every game at least once",
        gamesTried.size,
        3,
        1,
        "One more game to try."
      ),
      make(
        "three",
        "Three in a Row",
        "Three days running",
        best,
        3,
        1,
        "Three days is where a habit starts to hold."
      ),
      make(
        "noted",
        "Worth Remembering",
        "Added a note to a check-in",
        notedSomething ? 1 : 0,
        1,
        1,
        "Jot down anything unusual — it explains a lot later."
      ),
      make(
        "rain",
        "Rain or Shine",
        "Checked in after a short night",
        shortNight ? 1 : 0,
        1,
        2,
        "The honest days matter most."
      ),
      make(
        "storm",
        "Weathered It",
        "Checked in on a heavy day",
        heavyDay ? 1 : 0,
        1,
        2,
        "Showing up when it is hard is the whole point."
      ),
      make(
        "kind",
        "Kind to Yourself",
        "Checked in when your mood was low",
        lowMood ? 1 : 0,
        1,
        2,
        "No pressure. Just noticing counts."
      ),
      make(
        "week",
        "Full Week",
        "Seven days running",
        best,
        7,
        2,
        "A full week is a real achievement."
      ),
      make(
        "comeback",
        "Back Again",
        "Returned after a break of a week or more",
        hadGap(sessions, 7) ? 1 : 0,
        1,
        2,
        "Missed days are normal. Coming back is what counts."
      ),
      make(
        "baseline",
        "Baseline Built",
        "Fourteen check-ins — your range begins",
        count,
        14,
        3,
        "At fourteen, MindTrace starts comparing you with you."
      ),
      make(
        "thirty",
        "Thirty Sessions",
        "Thirty check-ins recorded",
        count,
        30,
        3,
        "Thirty days of your own history."
      ),
      make(
        "fortnight",
        "Fourteen Straight",
        "Fourteen days running",
        best,
        14,
        3,
        "Two unbroken weeks."
      ),
      make(
        "month",
        "Month Streak",
        "Thirty days running",
        best,
        30,
        3,
        "A month without a gap."
      ),
      make(
        "century",
        "Hundred Days",
        "One hundred check-ins",
        count,
        100,
        3,
        "The long view."
      )
    ];
  }

  function nextBadge(sessions) {
    const locked = badgesFor(sessions).filter(
      (badge) => !badge.unlocked
    );

    if (!locked.length) return null;

    locked.sort(
      (a, b) =>
        b.progress - a.progress
        || a.remaining - b.remaining
    );

    return locked[0];
  }

  function encouragement(sessions) {
    const count = sessions.length;
    const now = currentStreak(sessions);
    const away = daysSince(sessions);

    if (!count) return "Your first check-in takes about five minutes.";
    if (away > 2) {
      return `It has been ${away} days. Nothing is lost — pick up where you left off.`;
    }
    if (count === 1) {
      return "One down. The picture builds a day at a time.";
    }
    if (count < 14) {
      return `${14 - count} more check-ins until MindTrace can compare a day with your own usual range.`;
    }
    if (count === 14) {
      return "Fourteen in. From here, each day is measured against your own rhythm.";
    }
    if (now >= 7) {
      return `${now} days running. That is a real habit now.`;
    }
    if (now >= 3) {
      return `${now} days in a row. Nicely steady.`;
    }

    return "Good to have you back. Every check-in adds another point to your picture.";
  }

  return {
    clamp,
    mean,
    standardDeviation,
    accuracyFor,
    analyticsRows,
    rollingAverage,
    personalBaseline,
    deviationPercent,
    correlation,
    sleepScore,
    scoreSymbolMatch,
    scoreMemory,
    scoreWords,
    calculateDomains,
    composite,
    getBaseline,
    verdictFor,
    currentStreak,
    longestStreak,
    toDateKey,
    badgesFor,
    nextBadge,
    encouragement,
    daysSince
  };
});