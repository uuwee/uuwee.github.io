// Convert the selected month, conditions and sort settings into an ASP program.
window.ShiftScheduler = {
  monthData(availability, monthKey) {
    const days = Object.entries(availability?.days ?? {})
      .filter(([date]) => date.startsWith(`${monthKey}-`))
      .sort(([a], [b]) => a.localeCompare(b));
    const names = [...new Set([
      ...(availability?.staff?.[monthKey] ?? []),
      ...days.flatMap(([, slots]) => slots.flatMap((slot) => slot.names)),
    ])];
    const possible = new Set(days.flatMap(([, slots]) => slots.flatMap((slot) => slot.names)));
    const activeNames = names.filter((name) => possible.has(name));
    return { days, names, activeNames };
  },

  limits(conditions, date, time = '', availableCount) {
    // Date-only keys are retained as a fallback for states saved by older
    // versions, where the same limits applied to every slot on that date.
    const saved = conditions[time ? `${date} ${time}` : date] ?? conditions[date];
    if (Number.isInteger(saved?.min) && Number.isInteger(saved?.max) &&
        saved.min >= 0 && saved.max >= saved.min) return saved;
    const minimum = Number.isInteger(availableCount) && availableCount >= 0 ? availableCount : 3;
    return { min: minimum, max: Math.max(4, minimum) };
  },

  goals(saved = {}) {
    const defaults = {
      workCount: { enabled: false, min: 0, max: 8, trend: 'neutral' },
      workInterval: { enabled: false, min: 1, max: 7, trend: 'neutral' },
      workBalance: { enabled: false, max: 2, trend: 'even' },
      scarceAvailability: { enabled: false, trend: 'neutral' },
    };
    const settings = {};
    for (const [key, fallback] of Object.entries(defaults)) {
      const value = saved?.[key] ?? {};
      const goal = { ...fallback, enabled: Boolean(value.enabled) };
      for (const bound of ['min', 'max']) {
        if (fallback[bound] !== undefined && Number.isInteger(value[bound]) && value[bound] >= (key === 'workInterval' ? 1 : 0) && value[bound] <= 1000) goal[bound] = value[bound];
      }
      if (goal.min !== undefined && goal.max < goal.min) goal.max = goal.min;
      const trends = key === 'workCount' ? ['neutral', 'less', 'more'] : key === 'workInterval' ? ['neutral', 'shorter', 'longer'] : key === 'workBalance' ? ['neutral', 'even'] : ['neutral'];
      if (trends.includes(value.trend)) goal.trend = value.trend;
      settings[key] = goal;
    }
    const keys = Object.keys(defaults);
    settings.order = [...new Set([
      ...(Array.isArray(saved.order) ? saved.order.filter((key) => keys.includes(key)) : []),
      ...keys,
    ])];
    return settings;
  },

  build(availability, monthKey, dayConditions, groups, sort = {}) {
    const { days, names: allNames, activeNames: names } = this.monthData(availability, monthKey);
    const staffIds = new Map(names.map((name, index) => [name, index + 1]));
    const slots = [];
    const errors = [];
    const lines = [
      `% 勤務希望・条件・ソート：${monthKey}`,
      '% staff(スタッフID, 名前).',
      '% slot(勤務枠ID, 日付, 開始時刻).',
      '% available(スタッフID, 勤務枠ID).',
      '% required_slot(勤務枠ID, 最小人数, 最大人数).',
      '',
      ...names.map((name) => `staff(${staffIds.get(name)},${JSON.stringify(name)}).`),
      '',
    ];
    for (const [date, daySlots] of days) {
      lines.push(`day_index(${JSON.stringify(date)},${Number(date.slice(-2))}).`);
      const orderedSlots = [...daySlots].sort((a, b) => a.time.localeCompare(b.time));
      for (const [slotIndex, slot] of orderedSlots.entries()) {
        slots.push({ ...slot, date });
        const id = slots.length;
        const limits = this.limits(dayConditions, date, slot.time, slot.names.length);
        lines.push(`slot(${id},${JSON.stringify(date)},${JSON.stringify(slot.time)}).`);
        lines.push(`slot_order(${id},${JSON.stringify(date)},${slotIndex + 1}).`);
        lines.push(`required_slot(${id},${limits.min},${limits.max}).`);
        for (const name of slot.names) lines.push(`available(${staffIds.get(name)},${id}).`);
      }
      lines.push('');
    }
    const slotIds = new Map(slots.map((slot, index) => [`${slot.date} ${slot.time}`, index + 1]));
    lines.push('% 出勤可能者から、各勤務枠の人数条件を満たす人を選ぶ。',
      'Min { work(S,T) : available(S,T) } Max :- required_slot(T,Min,Max).', '');

    const slotRules = Array.isArray(groups.slotRules) ? groups.slotRules : [];
    if (slotRules.length) lines.push('% カレンダーから追加した勤務枠単位の固定条件。');
    for (const rule of slotRules) {
      const slotKey = `${rule.date} ${rule.time}`;
      const slotId = slotIds.get(slotKey);
      const slot = slots[slotId - 1];
      if (!slotId || !slot) {
        errors.push(`カレンダー条件の勤務枠「${slotKey}」が現在の勤務表にありません。`);
        continue;
      }
      const requireWork = (name, label) => {
        const staffId = staffIds.get(name);
        if (!staffId || !slot.names.includes(name)) {
          errors.push(`${label}の「${name}」は ${slotKey} に出勤できません。`);
          return;
        }
        lines.push(`:- not work(${staffId},${slotId}).`);
      };
      const forbidWork = (name, label) => {
        const staffId = staffIds.get(name);
        if (!staffId) {
          errors.push(`${label}のスタッフ「${name}」が現在の勤務表にいません。`);
          return;
        }
        lines.push(`:- work(${staffId},${slotId}).`);
      };
      if (rule.type === 'require') requireWork(rule.name, '出勤固定条件');
      else if (rule.type === 'forbid') forbidWork(rule.name, '出勤禁止条件');
      else if (rule.type === 'replace') {
        forbidWork(rule.from, '交代条件');
        requireWork(rule.to, '交代条件');
      } else errors.push(`カレンダー条件「${rule.type}」には対応していません。`);
    }
    if (slotRules.length) lines.push('');

    const rules = [
      { key: 'atLeastOne', id: 1, label: '少なくとも一人', exact: false },
      { key: 'exactlyOne', id: 2, label: '一人だけ', exact: true },
    ];
    for (const rule of rules) {
      const group = groups[rule.key];
      if (!group?.enabled) continue;
      const selected = [...new Set(group.names ?? [])];
      if (!selected.length) errors.push(`「${rule.label}は出勤する」の対象スタッフを選択してください。`);
      if (selected.some((name) => !allNames.includes(name))) errors.push(`「${rule.label}は出勤する」に現在の勤務表にないスタッフが含まれています。選択を見直してください。`);
      lines.push(`% 選択したスタッフのうち${rule.label}が各勤務枠に出勤する。`);
      for (const name of selected) {
        if (staffIds.has(name)) lines.push(`member(${rule.id},${staffIds.get(name)}).`);
      }
      // An empty enabled group is inconsistent; the UI also explains the missing selection.
      if (!selected.some((name) => staffIds.has(name))) lines.push(':-.');
      else {
        lines.push(`:- slot(T,_,_), #count { S : work(S,T), member(${rule.id},S) } < 1.`);
        if (rule.exact) lines.push(`:- slot(T,_,_), #count { S : work(S,T), member(${rule.id},S) } > 1.`);
      }
      lines.push('');
    }
    const exactCounts = groups.exactWorkCounts?.counts ?? {};
    if (Object.keys(exactCounts).length) {
      lines.push('% 指定したスタッフの月内の出勤回数（勤務コマ数）を固定する。');
      for (const [name, count] of Object.entries(exactCounts)) {
        if (!allNames.includes(name)) {
          errors.push(`「${name}が出勤する回数」のスタッフが現在の勤務表にいません。設定を見直してください。`);
          continue;
        }
        const staffId = staffIds.get(name);
        const possible = slots.filter((slot) => slot.names.includes(name)).length;
        if (!Number.isInteger(count) || count < 0 || count > possible) {
          errors.push(`「${name}が出勤する回数」は0〜${possible}回で設定してください。`);
          continue;
        }
        // A staff member with no available slots is omitted from staff/2 and
        // already satisfies an exact count of zero.
        if (staffId !== undefined) lines.push(`exact_work_count(${staffId},${count}).`);
      }
      lines.push(':- exact_work_count(S,N), N != #count { T : work(S,T) }.', '');
    }
    if (groups.continuousDailyShift?.enabled) {
      lines.push('% 同じスタッフの一日の勤務コマを連続させる。',
        'between_slot(D,A,B,C) :- slot_order(A,D,IA), slot_order(B,D,IB), slot_order(C,D,IC), IA < IC, IC < IB.',
        ':- work(S,A), work(S,B), between_slot(D,A,B,C), not work(S,C).', '');
    }
    const context = lines.join('\n');
    const goals = this.goals(sort);
    const optimized = goals.order.some((key) => goals[key].enabled);
    // Higher priorities are optimized first. Each item's range and trend
    // both take precedence over every item below it.
    const priority = (key) => (goals.order.length - goals.order.indexOf(key)) * 2;
    lines.push(`% ソートの優先順：${goals.order.filter((key) => goals[key].enabled).join(' > ') || 'なし'}`, '');
    const possibleCounts = names.map((name) => slots.filter((slot) => slot.names.includes(name)).length);
    if (goals.workCount.enabled || goals.workBalance.enabled || goals.scarceAvailability.enabled) {
      lines.push('% 各スタッフの月内の出勤回数（勤務コマ数）。',
        'work_count(S,N) :- staff(S,_), N = #count { T : work(S,T) }.', '');
    }
    if (goals.workCount.enabled) {
      const { min, max, trend } = goals.workCount;
      const rank = priority('workCount');
      lines.push('% ソート：出勤回数の目標範囲からのずれを減らす。',
        `:~ work_count(S,N), N < ${min}. [(${min}-N)@${rank},count_low,S]`,
        `:~ work_count(S,N), N > ${max}. [(N-${max})@${rank},count_high,S]`);
      if (trend === 'less') lines.push(`:~ work_count(S,N). [N@${rank - 1},count_trend,S]`);
      if (trend === 'more') lines.push(`:~ work_count(S,N). [(${slots.length}-N)@${rank - 1},count_trend,S]`);
      lines.push('');
    }
    if (goals.workInterval.enabled) {
      const { min, max, trend } = goals.workInterval;
      const rank = priority('workInterval');
      const daysInMonth = new Date(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5)), 0).getDate();
      lines.push('% ソート：月内の連続する出勤日間の日数を目標に近づける。',
        'worked_day(S,N) :- work(S,T), slot(T,D,_), day_index(D,N).',
        'between_work(S,A,B) :- worked_day(S,A), worked_day(S,B), worked_day(S,C), A < C, C < B.',
        'work_gap(S,A,B,G) :- worked_day(S,A), worked_day(S,B), A < B, not between_work(S,A,B), G = B-A.',
        `:~ work_gap(S,A,B,G), G < ${min}. [(${min}-G)@${rank},gap_low,S,A,B]`,
        `:~ work_gap(S,A,B,G), G > ${max}. [(G-${max})@${rank},gap_high,S,A,B]`);
      if (trend === 'shorter') lines.push(`:~ work_gap(S,A,B,G). [G@${rank - 1},gap_trend,S,A,B]`);
      if (trend === 'longer') lines.push(`:~ work_gap(S,A,B,G). [(${daysInMonth}-G)@${rank - 1},gap_trend,S,A,B]`);
      lines.push('');
    }
    if (goals.workBalance.enabled) {
      const { max, trend } = goals.workBalance;
      const rank = priority('workBalance');
      lines.push('% ソート：全スタッフの各組の出勤回数差を目標に近づける。',
        'work_difference(A,B,X-Y) :- work_count(A,X), work_count(B,Y), A < B, X >= Y.',
        'work_difference(A,B,Y-X) :- work_count(A,X), work_count(B,Y), A < B, X < Y.',
        `:~ work_difference(A,B,D), D > ${max}. [(D-${max})@${rank},balance_limit,A,B]`);
      if (trend === 'even') lines.push(`:~ work_difference(A,B,D). [D@${rank - 1},balance_trend,A,B]`);
      lines.push('');
    }
    if (goals.scarceAvailability.enabled) {
      const maxPossible = Math.max(0, ...possibleCounts);
      const rank = priority('scarceAvailability');
      lines.push('% ソート：出勤可能回数が少ない先生の未割り当てを重く評価する。',
        ...possibleCounts.map((count, index) => `possible_count(${index + 1},${count}).`),
        `:~ work_count(S,N), possible_count(S,P), P > 0. [(${maxPossible + 1}-P)*(P-N)@${rank},scarce_priority,S]`, '');
    }
    lines.push('#show work/2.', '');
    // Enumerate without a model or conflict limit. When soft goals are active,
    // clingcon keeps improving their lexicographic objective during the run.
    const options = `--models=0 --outf=2${optimized ? ' --opt-mode=opt' : ''}`;
    return { program: lines.join('\n'), context, names, slots, errors, optimized, options, goals, possibleCounts };
  },

  score(assignments, problem) {
    const counts = problem.names.map((name) => problem.slots.filter((slot) =>
      assignments[`${slot.date} ${slot.time}`]?.includes(name)).length);
    const scores = { workCount: [0, 0], workInterval: [0, 0], workBalance: [0, 0], scarceAvailability: [0, 0] };
    const goals = problem.goals;
    const count = goals.workCount;
    if (count.enabled) for (const value of counts) {
      scores.workCount[0] += Math.max(0, count.min - value) + Math.max(0, value - count.max);
      scores.workCount[1] += count.trend === 'less' ? value : count.trend === 'more' ? problem.slots.length - value : 0;
    }
    const interval = goals.workInterval;
    if (interval.enabled) {
      const firstDate = problem.slots[0]?.date;
      const daysInMonth = firstDate ? new Date(Number(firstDate.slice(0, 4)), Number(firstDate.slice(5, 7)), 0).getDate() : 31;
      for (const name of problem.names) {
        const days = [...new Set(problem.slots.filter((slot) =>
          assignments[`${slot.date} ${slot.time}`]?.includes(name)).map((slot) => Number(slot.date.slice(-2))))].sort((a, b) => a - b);
        for (let index = 1; index < days.length; index++) {
          const gap = days[index] - days[index - 1];
          scores.workInterval[0] += Math.max(0, interval.min - gap) + Math.max(0, gap - interval.max);
          scores.workInterval[1] += interval.trend === 'shorter' ? gap : interval.trend === 'longer' ? daysInMonth - gap : 0;
        }
      }
    }
    const balance = goals.workBalance;
    if (balance.enabled) for (let a = 0; a < counts.length; a++) {
      for (let b = a + 1; b < counts.length; b++) {
        const difference = Math.abs(counts[a] - counts[b]);
        scores.workBalance[0] += Math.max(0, difference - balance.max);
        if (balance.trend === 'even') scores.workBalance[1] += difference;
      }
    }
    if (goals.scarceAvailability.enabled) {
      const maxPossible = Math.max(0, ...problem.possibleCounts);
      problem.possibleCounts.forEach((possible, index) => {
        if (possible > 0) scores.scarceAvailability[0] += (maxPossible + 1 - possible) * (possible - counts[index]);
      });
    }
    return goals.order.flatMap((key) => scores[key]);
  },

  readWitness(witness, problem) {
    if (!Array.isArray(witness.Value)) throw new Error('Clingcon の出力に解がありません。');
    const assignments = {};
    for (const slot of problem.slots) assignments[`${slot.date} ${slot.time}`] = [];
    for (const atom of witness.Value) {
      const match = /^work\((\d+),(\d+)\)$/.exec(atom);
      if (!match) throw new Error('Clingcon の出力に未対応の形式があります。');
      const name = problem.names[Number(match[1]) - 1];
      const slot = problem.slots[Number(match[2]) - 1];
      if (!name || !slot || !slot.names.includes(name)) throw new Error('Clingcon の出力と勤務希望が一致しません。');
      assignments[`${slot.date} ${slot.time}`].push(name);
    }
    return { assignments, costs: witness.Costs ?? [] };
  },

  readResult(stdout, problem) {
    const result = JSON.parse(stdout);
    if (result.Result === 'UNSATISFIABLE') return { assignments: null, candidates: [], optimal: false, exhausted: true };
    const witnesses = result.Call?.flatMap((call) => call.Witnesses ?? []) ?? [];
    if (!witnesses.length && result.Result === 'UNKNOWN') return { assignments: null, candidates: [], optimal: false, exhausted: false };
    if (!witnesses.length) throw new Error('探索を終えるまでに候補を取得できませんでした。条件の見直し、または有効なソートを減らして再検索してください。');
    const candidates = witnesses.map((witness) => this.readWitness(witness, problem));
    if (problem.optimized) candidates.reverse();
    return { assignments: candidates[0].assignments, candidates, optimal: result.Result === 'OPTIMUM FOUND', exhausted: result.Models?.More === 'no' };
  },
};
