(() => {
  const get = (id) => document.getElementById(id);
  const storageKey = 'scheduler-view-v1';
  const maxRetainedSolutions = 1000;
  const today = new Date();
  const groupRules = [
    { key: 'atLeastOne', label: '…のうち少なくとも一人は出勤する' },
    { key: 'exactlyOne', label: '…のうち一人が出勤する', help: '選んだスタッフのうち、ちょうど一人が出勤します。' },
  ];
  const goalRules = [
    { key: 'workCount', label: '出勤回数', help: '月内の勤務コマ数を、各スタッフについて目標に近づけます。',
      bounds: [['min', '下限目標（回）'], ['max', '上限目標（回）']],
      trends: [['neutral', '指定なし'], ['less', 'なるべく少なめ'], ['more', 'なるべく多め']] },
    { key: 'workInterval', label: '出勤間隔', help: '月内で連続する2つの出勤日の差を日数で評価します。同じ日の複数コマは1日として扱います。',
      bounds: [['min', '下限目標（日）'], ['max', '上限目標（日）']],
      trends: [['neutral', '指定なし'], ['shorter', 'なるべく短め'], ['longer', 'なるべく長め']] },
    { key: 'workBalance', label: '出勤回数の偏り', help: 'スタッフ間の勤務コマ数の差を、できるだけ小さくします。',
      bounds: [['max', '許容する差の目標（回）']],
      trends: [['even', 'なるべく均等に'], ['neutral', '許容する差を目安に']] },
    { key: 'scarceAvailability', label: '出勤可能回数が少ない先生を優先',
      help: '出勤可能なコマが少ない先生ほど優先して出勤に割り当てます。未割り当てのコマ数を、出勤可能回数が少ない先生ほど重く評価します。出勤可能回数が0の先生は評価対象に含めません。',
      bounds: [], trends: [] },
  ];
  let month = new Date(today.getFullYear(), today.getMonth(), 1);
  let availability = null;
  let workbookAvailability = null;
  let manualStaff = {};
  let sourceName = '';
  let selectedStaff = '';
  let solutionOptimal = false;
  let dayConditions = {};
  let monthConditions = {};
  let monthSort = {};
  let draggedSort = null;
  let solutions = [];
  let solutionKeys = new Set();
  let exploredSolutions = 0;
  const assignmentKeys = new WeakMap();
  const assignmentScores = new WeakMap();
  let scoreSignature = '';
  let solutionIndex = 0;
  let goodCandidates = {};
  let explorationExhausted = false;
  let assignments = null;
  let problem = null;
  let solveState = 'empty';
  let solveMessage = '';
  let solveTimer;
  let progressTimer;
  let pendingWitnesses = [];
  let worker;
  let revision = 0;
  let factoryPromise;

  function monthKey() {
    return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
  }
  function hasMonth() { return availability?.months.includes(monthKey()); }
  function monthData() { return ShiftScheduler.monthData(availability, monthKey()); }
  function groups() { return monthConditions[monthKey()] ?? {}; }
  function calendarRules() { return groups().slotRules ?? []; }
  function sortSettings() { return monthSort[monthKey()] ?? {}; }
  function normalizeCalendarRules(rules) {
    const expanded = (Array.isArray(rules) ? rules : []).flatMap((rule) => rule.type === 'replace' ? [
      { type: 'forbid', date: rule.date, time: rule.time, name: rule.from },
      { type: 'require', date: rule.date, time: rule.time, name: rule.to },
    ] : [rule]);
    const normalized = [];
    for (const rule of expanded) {
      if (!['require', 'forbid'].includes(rule.type)) continue;
      const opposite = rule.type === 'require' ? 'forbid' : 'require';
      for (let index = normalized.length - 1; index >= 0; index--) {
        const saved = normalized[index];
        if (saved.date === rule.date && saved.time === rule.time && saved.name === rule.name && saved.type === opposite) {
          normalized.splice(index, 1);
        }
      }
      if (!normalized.some((saved) => saved.type === rule.type && saved.date === rule.date &&
          saved.time === rule.time && saved.name === rule.name)) normalized.push(rule);
    }
    return normalized;
  }
  function storageUnavailable() {
    get('storage-status').textContent = 'このブラウザでは設定を保存できません。現在の画面では操作できます。';
  }
  function restoreState(saved) {
    month = new Date(today.getFullYear(), today.getMonth(), 1);
    workbookAvailability = null;
    sourceName = '';
    selectedStaff = '';
    manualStaff = {};
    dayConditions = {};
    monthConditions = {};
    monthSort = {};
    goodCandidates = {};
    get('file-status').textContent = 'ファイルは未選択です。';
    for (const layer of ['availability', 'attendance', 'conditions']) get(`layer-${layer}`).checked = true;
    if (saved) {
      if (Number.isInteger(saved.year) && saved.year >= 1900 && saved.year <= 9999 &&
          Number.isInteger(saved.month) && saved.month >= 0 && saved.month <= 11) {
        month = new Date(saved.year, saved.month, 1);
      }
      if (typeof saved.selectedStaff === 'string') selectedStaff = saved.selectedStaff;
      for (const layer of ['availability', 'attendance', 'conditions']) {
        if (typeof saved.layers?.[layer] === 'boolean') get(`layer-${layer}`).checked = saved.layers[layer];
      }
      if (saved.availability && Array.isArray(saved.availability.months) && saved.availability.days) {
        workbookAvailability = saved.availability;
        sourceName = saved.sourceName || '保存済みの勤務表';
        get('file-status').textContent = `保存済み：${sourceName}（再読込する場合はファイルを選択）`;
      }
      if (saved.conditions?.days && typeof saved.conditions.days === 'object') dayConditions = saved.conditions.days;
      if (saved.conditions?.months && typeof saved.conditions.months === 'object') monthConditions = saved.conditions.months;
      if (saved.sort && typeof saved.sort === 'object') monthSort = saved.sort;
      if (saved.goodCandidates && typeof saved.goodCandidates === 'object') goodCandidates = saved.goodCandidates;
      // Move previously saved soft goals out of the hard conditions.
      for (const [key, conditions] of Object.entries(monthConditions)) {
        if (conditions.goals && !monthSort[key]) monthSort[key] = conditions.goals;
        delete conditions.goals;
      }
      if (saved.manualStaff && typeof saved.manualStaff === 'object') manualStaff = saved.manualStaff;
      for (const conditions of Object.values(monthConditions)) {
        if (Array.isArray(conditions.slotRules)) conditions.slotRules = normalizeCalendarRules(conditions.slotRules);
      }
    }
  }
  try { restoreState(JSON.parse(localStorage.getItem(storageKey))); }
  catch { storageUnavailable(); }

  function applyManualStaff() {
    if (!workbookAvailability) { availability = null; return; }
    availability = {
      ...workbookAvailability,
      staff: { ...workbookAvailability.staff },
      days: { ...workbookAvailability.days },
    };
    for (const key of workbookAvailability.months) {
      const { days, names } = ShiftScheduler.monthData(workbookAvailability, key);
      const additions = (manualStaff[key] ?? []).filter((person) => !names.includes(person.name));
      availability.staff[key] = [...new Set([...names, ...additions.map((person) => person.name)])];
      for (const [date, slots] of days) {
        availability.days[date] = slots.map((slot) => ({
          ...slot,
          names: [...new Set([...slot.names, ...additions
            .filter((person) => !person.unavailable.includes(`${date} ${slot.time}`))
            .map((person) => person.name)])],
        }));
      }
    }
  }
  applyManualStaff();

  function currentState() {
    return {
        year: month.getFullYear(), month: month.getMonth(),
        availability: workbookAvailability, sourceName, manualStaff, selectedStaff,
        conditions: { days: dayConditions, months: monthConditions },
        sort: monthSort,
        goodCandidates,
        layers: {
          availability: get('layer-availability').checked,
          attendance: get('layer-attendance').checked,
          conditions: get('layer-conditions').checked,
        },
    };
  }
  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(currentState()));
    } catch { storageUnavailable(); }
  }

  function renderStaff() {
    const { names, activeNames } = monthData();
    if (!activeNames.includes(selectedStaff)) selectedStaff = '';
    get('staff-empty').hidden = names.length > 0;
    const list = document.createDocumentFragment();
    for (const name of names) {
      const person = document.createElement('li');
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'staff-name secondary';
      label.dataset.staff = name;
      label.disabled = !activeNames.includes(name);
      if (label.disabled) label.title = '表示月の出勤可能コマがないため、探索対象から除外しています。';
      label.setAttribute('aria-pressed', String(selectedStaff === name));
      label.textContent = name;
      person.append(label);
      list.append(person);
    }
    get('staff-list').replaceChildren(list);
  }

  function closeStaffForm() {
    get('staff-add-form').hidden = true;
    get('staff-add-form').reset();
    get('staff-name').setCustomValidity('');
    get('show-staff-form').setAttribute('aria-expanded', 'false');
  }
  function showStaffForm() {
    get('staff-add-form').reset();
    get('staff-name').setCustomValidity('');
    get('staff-status').textContent = '';
    renderUnavailableCalendar();
    get('add-staff').disabled = !hasMonth();
    get('staff-add-form').hidden = false;
    get('show-staff-form').setAttribute('aria-expanded', 'true');
    get('staff-name').focus();
  }

  function renderUnavailableCalendar() {
    const container = get('staff-unavailable');
    if (!hasMonth()) {
      container.textContent = '先に、表示月の勤務希望を Excel から読み込んでください。';
      return;
    }
    const year = month.getFullYear();
    const index = month.getMonth();
    const table = document.createElement('table');
    table.className = 'staff-calendar';
    const caption = document.createElement('caption');
    caption.textContent = `${year}年${index + 1}月：チェックしたコマは出勤不可`;
    table.append(caption);
    const head = document.createElement('thead');
    const header = document.createElement('tr');
    for (const weekday of ['日', '月', '火', '水', '木', '金', '土']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = weekday;
      header.append(cell);
    }
    head.append(header);
    table.append(head);
    const body = document.createElement('tbody');
    const days = new Date(year, index + 1, 0).getDate();
    const first = month.getDay();
    for (let week = 0; week < Math.ceil((first + days) / 7); week++) {
      const row = document.createElement('tr');
      for (let weekday = 0; weekday < 7; weekday++) {
        const cell = document.createElement('td');
        const day = week * 7 + weekday - first + 1;
        if (day < 1 || day > days) cell.className = 'empty';
        else {
          const date = `${monthKey()}-${String(day).padStart(2, '0')}`;
          const number = document.createElement('time');
          number.dateTime = date;
          number.textContent = day;
          cell.append(number);
          const slots = availability.days[date] ?? [];
          for (const slot of slots) {
            const label = document.createElement('label');
            label.className = 'check-label';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.dataset.slot = `${date} ${slot.time}`;
            input.setAttribute('aria-label', `${date} ${slot.time}を出勤不可にする`);
            label.append(input, document.createTextNode(` ${slot.time}`));
            cell.append(label);
          }
          if (!slots.length) {
            const note = document.createElement('span');
            note.className = 'no-slots';
            note.textContent = '勤務枠なし';
            cell.append(note);
          }
        }
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body);
    container.replaceChildren(table);
  }

  function renderGroups() {
    const { names } = monthData();
    get('conditions-month').textContent = `${month.getFullYear()}年${month.getMonth() + 1}月の条件`;
    const fields = document.createDocumentFragment();
    for (const rule of groupRules) {
      const group = groups()[rule.key] ?? { enabled: false, names: [] };
      const field = document.createElement('div');
      field.className = 'group-condition';
      field.setAttribute('role', 'group');
      field.setAttribute('aria-labelledby', `condition-title-${rule.key}`);
      const header = document.createElement('div');
      header.className = 'condition-header';
      const title = document.createElement('button');
      title.type = 'button';
      title.id = `condition-title-${rule.key}`;
      title.className = 'sort-title';
      title.textContent = rule.label;
      title.setAttribute('aria-expanded', 'false');
      title.setAttribute('aria-controls', `condition-details-${rule.key}`);
      header.append(title);
      const enabledLabel = document.createElement('label');
      enabledLabel.className = 'check-label';
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.dataset.group = rule.key;
      enabled.checked = Boolean(group.enabled);
      enabled.disabled = !hasMonth();
      enabledLabel.append(enabled, ' 有効化');
      enabled.setAttribute('aria-label', `${rule.label}の有効化`);
      header.append(enabledLabel);
      field.append(header);
      const details = document.createElement('div');
      details.className = 'condition-details';
      details.id = `condition-details-${rule.key}`;
      details.hidden = true;
      title.addEventListener('click', () => {
        details.hidden = !details.hidden;
        title.setAttribute('aria-expanded', String(!details.hidden));
      });
      const summary = document.createElement('p');
      summary.id = `group-summary-${rule.key}`;
      summary.textContent = `対象スタッフを選択（${group.names?.length ?? 0}人選択中）`;
      details.append(summary);
      const help = document.createElement('p');
      help.className = 'help';
      help.textContent = rule.help ?? '選んだスタッフのうち、一人以上が出勤します。';
      details.append(help);
      const staff = document.createElement('div');
      staff.className = 'staff-options';
      for (const name of new Set([...names, ...(group.names ?? [])])) {
        const label = document.createElement('label');
        label.className = 'check-label';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.group = rule.key;
        input.dataset.staff = name;
        input.checked = group.names?.includes(name) ?? false;
        label.append(input, document.createTextNode(` ${name}${names.includes(name) ? '' : '（勤務表に不在）'}`));
        staff.append(label);
      }
      if (!names.length) staff.textContent = '勤務希望を読み込むと、スタッフを選択できます。';
      details.append(staff);
      field.append(details);
      fields.append(field);
    }
    const continuous = groups().continuousDailyShift ?? { enabled: false };
    const continuousField = document.createElement('div');
    continuousField.className = 'group-condition';
    continuousField.setAttribute('role', 'group');
    continuousField.setAttribute('aria-labelledby', 'condition-title-continuousDailyShift');
    const continuousHeader = document.createElement('div');
    continuousHeader.className = 'condition-header';
    const continuousTitle = document.createElement('button');
    continuousTitle.type = 'button';
    continuousTitle.id = 'condition-title-continuousDailyShift';
    continuousTitle.className = 'sort-title';
    continuousTitle.textContent = '一日に不連続なシフトを作成しない';
    continuousTitle.setAttribute('aria-expanded', 'false');
    continuousTitle.setAttribute('aria-controls', 'condition-details-continuousDailyShift');
    continuousHeader.append(continuousTitle);
    const continuousLabel = document.createElement('label');
    continuousLabel.className = 'check-label';
    const continuousEnabled = document.createElement('input');
    continuousEnabled.type = 'checkbox';
    continuousEnabled.dataset.monthCondition = 'continuousDailyShift';
    continuousEnabled.checked = Boolean(continuous.enabled);
    continuousEnabled.disabled = !hasMonth();
    continuousEnabled.setAttribute('aria-label', '一日に不連続なシフトを作成しない条件の有効化');
    continuousLabel.append(continuousEnabled, ' 有効化');
    continuousHeader.append(continuousLabel);
    continuousField.append(continuousHeader);
    const continuousDetails = document.createElement('div');
    continuousDetails.className = 'condition-details';
    continuousDetails.id = 'condition-details-continuousDailyShift';
    continuousDetails.hidden = true;
    continuousTitle.addEventListener('click', () => {
      continuousDetails.hidden = !continuousDetails.hidden;
      continuousTitle.setAttribute('aria-expanded', String(!continuousDetails.hidden));
    });
    const continuousHelp = document.createElement('p');
    continuousHelp.className = 'help';
    continuousHelp.textContent = '同じスタッフが一日に複数コマ出勤する場合、間にある勤務コマにも出勤する連続したシフトだけを作成します。';
    continuousDetails.append(continuousHelp);
    continuousField.append(continuousDetails);
    fields.append(continuousField);
    const exact = groups().exactWorkCounts ?? { counts: {} };
    const exactField = document.createElement('div');
    exactField.className = 'group-condition';
    exactField.setAttribute('role', 'group');
    exactField.setAttribute('aria-labelledby', 'condition-title-exactWorkCounts');
    const exactHeader = document.createElement('div');
    exactHeader.className = 'condition-header';
    const exactTitle = document.createElement('button');
    exactTitle.type = 'button';
    exactTitle.id = 'condition-title-exactWorkCounts';
    exactTitle.className = 'sort-title';
    exactTitle.textContent = '…が出勤する回数';
    exactTitle.setAttribute('aria-expanded', 'false');
    exactTitle.setAttribute('aria-controls', 'condition-details-exactWorkCounts');
    exactHeader.append(exactTitle);
    exactField.append(exactHeader);
    const exactDetails = document.createElement('div');
    exactDetails.className = 'condition-details';
    exactDetails.id = 'condition-details-exactWorkCounts';
    exactDetails.hidden = true;
    exactTitle.addEventListener('click', () => {
      exactDetails.hidden = !exactDetails.hidden;
      exactTitle.setAttribute('aria-expanded', String(!exactDetails.hidden));
    });
    const exactHelp = document.createElement('p');
    exactHelp.className = 'help';
    exactHelp.textContent = '有効にしたスタッフについて、表示月の出勤回数を指定した回数に固定します。上限はそのスタッフの出勤可能回数です。';
    exactDetails.append(exactHelp);
    const exactStaff = document.createElement('div');
    exactStaff.className = 'exact-count-options';
    const { days } = monthData();
    for (const name of names) {
      const possible = days.reduce((total, [, slots]) => total + slots.filter((slot) => slot.names.includes(name)).length, 0);
      const enabled = Object.prototype.hasOwnProperty.call(exact.counts ?? {}, name);
      const savedCount = enabled && Number.isInteger(exact.counts[name]) ? exact.counts[name] : 0;
      const value = Math.max(0, Math.min(possible, savedCount));
      if (enabled && savedCount !== value) exact.counts[name] = value;
      const row = document.createElement('div');
      row.className = 'exact-count-row';
      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'check-label';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.dataset.exactCountToggle = name;
      toggle.checked = enabled;
      toggle.disabled = !hasMonth();
      toggleLabel.append(toggle, document.createTextNode(` ${name}`));
      const rangeLabel = document.createElement('label');
      rangeLabel.className = 'exact-count-control';
      const description = document.createElement('span');
      description.textContent = `出勤回数（出勤可能 ${possible}回）`;
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = String(possible);
      range.step = '1';
      range.value = String(value);
      range.disabled = !enabled || !hasMonth();
      range.dataset.exactCountStaff = name;
      range.setAttribute('aria-label', `${name}が出勤する回数`);
      range.setAttribute('aria-valuetext', `${value}回`);
      const output = document.createElement('output');
      output.dataset.exactCountOutput = name;
      output.textContent = `${value}回`;
      rangeLabel.append(description, range, output);
      row.append(toggleLabel, rangeLabel);
      exactStaff.append(row);
    }
    if (!names.length) exactStaff.textContent = '勤務希望を読み込むと、スタッフごとの回数を設定できます。';
    exactDetails.append(exactStaff);
    exactField.append(exactDetails);
    fields.append(exactField);
    get('group-conditions').replaceChildren(fields);
    renderSort();
  }

  function renderSort() {
    get('sort-month').textContent = `${month.getFullYear()}年${month.getMonth() + 1}月のソート`;
    const settings = ShiftScheduler.goals(sortSettings());
    const total = monthData().days.reduce((count, [, slots]) => count + slots.length, 0);
    const fields = document.createDocumentFragment();
    for (const key of settings.order) {
      const rule = goalRules.find((rule) => rule.key === key);
      const goal = settings[rule.key];
      const field = document.createElement('div');
      field.className = 'group-condition sort-item';
      field.dataset.sort = rule.key;
      field.setAttribute('role', 'group');
      field.setAttribute('aria-labelledby', `sort-title-${rule.key}`);
      const header = document.createElement('div');
      header.className = 'sort-header';
      const title = document.createElement('button');
      title.type = 'button';
      title.id = `sort-title-${rule.key}`;
      title.className = 'sort-title';
      title.textContent = rule.label;
      title.setAttribute('aria-expanded', 'false');
      title.setAttribute('aria-controls', `sort-details-${rule.key}`);
      header.append(title);
      const reorder = document.createElement('div');
      reorder.className = 'sort-reorder';
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'secondary sort-handle';
      handle.draggable = true;
      handle.textContent = '↕ 並べ替え';
      handle.setAttribute('aria-label', `${rule.label}をドラッグして並べ替え`);
      reorder.append(handle);
      for (const [direction, text] of [['up', '上へ'], ['down', '下へ']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.dataset.move = direction;
        button.textContent = text;
        button.setAttribute('aria-label', `${rule.label}を${text}移動`);
        reorder.append(button);
      }
      const enabledLabel = document.createElement('label');
      enabledLabel.className = 'check-label';
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.dataset.goal = rule.key;
      enabled.dataset.field = 'enabled';
      enabled.checked = goal.enabled;
      enabled.disabled = !hasMonth();
      enabled.setAttribute('aria-label', `${rule.label}の有効化`);
      enabledLabel.append(enabled, ' 有効化');
      header.append(enabledLabel);
      header.append(reorder);
      field.append(header);
      const details = document.createElement('div');
      details.className = 'condition-details';
      details.id = `sort-details-${rule.key}`;
      details.hidden = true;
      title.addEventListener('click', () => {
        details.hidden = !details.hidden;
        title.setAttribute('aria-expanded', String(!details.hidden));
      });
      const help = document.createElement('p');
      help.className = 'help';
      help.textContent = rule.help;
      const controls = document.createElement('div');
      controls.className = 'goal-controls';
      function addControl(key, text, options) {
        const label = document.createElement('label');
        label.textContent = text;
        const control = document.createElement(options ? 'select' : 'input');
        control.id = `goal-${rule.key}-${key}`;
        control.dataset.goal = rule.key;
        control.dataset.field = key;
        if (options) {
          for (const [value, text] of options) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            control.append(option);
          }
        } else {
          control.type = 'number';
          control.required = true;
          control.min = rule.key === 'workInterval' ? 1 : 0;
          control.max = Math.max(rule.key === 'workInterval' ? 31 : total, goal.max, goal.min ?? 0);
          control.step = 1;
        }
        control.value = goal[key];
        label.append(control);
        controls.append(label);
      }
      for (const [key, text] of rule.bounds) addControl(key, text);
      if (rule.trends.length) addControl('trend', '傾向', rule.trends);
      details.append(help, controls);
      field.append(details);
      fields.append(field);
    }
    get('sort-settings').replaceChildren(fields);
    updateSortButtons();
    alignConditionHeaders();
  }

  function alignConditionHeaders() {
    const titles = [...document.querySelectorAll('.condition-header .sort-title, .sort-header .sort-title')];
    if (!titles.length) return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const style = getComputedStyle(titles[0]);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const width = Math.ceil(Math.max(...titles.map((title) => context.measureText(title.textContent).width))) + 28;
    get('group-conditions').closest('.workspace-column').style.setProperty('--condition-title-width', `${width}px`);
  }

  function updateSortButtons() {
    const items = [...get('sort-settings').children];
    items.forEach((item, index) => {
      item.querySelector('[data-move="up"]').disabled = index === 0;
      item.querySelector('[data-move="down"]').disabled = index === items.length - 1;
    });
  }

  function saveSortOrder() {
    const settings = ShiftScheduler.goals(sortSettings());
    settings.order = [...get('sort-settings').children].map((item) => item.dataset.sort);
    monthSort[monthKey()] = settings;
    updateSortButtons();
    save();
    queueSolve(false);
  }

  function clearSortDrag() {
    draggedSort = null;
    get('sort-settings').querySelectorAll('.sort-item').forEach((item) => {
      item.classList.remove('sort-dragging', 'sort-drop-before', 'sort-drop-after');
    });
  }

  function conditionWarning(date, time, limits) {
    const slot = (availability?.days[date] ?? []).find((item) => item.time === time);
    return slot && slot.names.length < limits.min ? '出勤可能者が最小人数に届きません。' : '';
  }
  function syncSlotRange(controls, limits) {
    const ranges = [...controls.querySelectorAll('input[type="range"]')];
    const maximum = Number(ranges[0]?.max ?? 1);
    const position = (value) => `${maximum ? value / maximum * 100 : 0}%`;
    controls.style.setProperty('--range-min', position(limits.min));
    controls.style.setProperty('--range-max', position(limits.max));
    controls.classList.toggle('min-on-top', limits.max === maximum);
    controls.querySelector('[data-people-range]').textContent = `${limits.min}〜${limits.max}人`;
    for (const range of ranges) {
      const value = limits[range.dataset.bound];
      range.value = value;
      range.setAttribute('aria-valuetext', `${value}人`);
    }
  }
  function makeSlotControls(date, time, staffCount) {
    const limits = ShiftScheduler.limits(dayConditions, date, time, staffCount);
    const controls = document.createElement('div');
    controls.className = 'slot-condition';
    controls.dataset.date = date;
    controls.dataset.time = time;
    const heading = document.createElement('strong');
    heading.textContent = `${time}の人数`;
    const summary = document.createElement('p');
    summary.className = 'people-range-summary';
    summary.append('必要人数：');
    const output = document.createElement('output');
    output.dataset.peopleRange = '';
    summary.append(output);
    const rangeContainer = document.createElement('div');
    rangeContainer.className = 'dual-range';
    const track = document.createElement('span');
    track.className = 'dual-range-track';
    rangeContainer.append(track);
    for (const [bound, text] of [['min', '最小'], ['max', '最大']]) {
      const input = document.createElement('input');
      input.type = 'range';
      input.dataset.bound = bound;
      input.min = 0;
      input.max = Math.max(4, staffCount, limits.max);
      input.step = 1;
      input.value = limits[bound];
      input.setAttribute('aria-label', `${date} ${time}の${text}人数`);
      rangeContainer.append(input);
    }
    const warning = document.createElement('p');
    warning.className = 'condition-warning';
    warning.textContent = conditionWarning(date, time, limits);
    controls.append(heading, summary, rangeContainer, warning);
    syncSlotRange(controls, limits);
    return controls;
  }

  function describeSlotRule(rule) {
    if (rule.type === 'require') return `${rule.name}が出勤する`;
    if (rule.type === 'forbid') return `${rule.name}は出勤しない`;
    return `${rule.from}から${rule.to}へ交代する`;
  }

  function makeSlotConditions(date, time) {
    const container = document.createElement('div');
    container.className = 'slot-conditions';
    const heading = document.createElement('strong');
    heading.textContent = `${time}の固定条件`;
    container.append(heading);
    const matching = calendarRules().map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.date === date && rule.time === time);
    if (!matching.length) {
      const empty = document.createElement('p');
      empty.className = 'no-slots';
      empty.textContent = '固定条件なし';
      container.append(empty);
      return container;
    }
    const list = document.createElement('ul');
    for (const { rule, index } of matching) {
      const item = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = describeSlotRule(rule);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary remove-slot-rule';
      remove.dataset.removeSlotRule = String(index);
      remove.textContent = '削除';
      remove.setAttribute('aria-label', `${date} ${time}の「${describeSlotRule(rule)}」条件を削除`);
      item.append(text, remove);
      list.append(item);
    }
    container.append(list);
    return container;
  }

  function addCalendarRules(newRules) {
    const conditions = monthConditions[monthKey()] ??= {};
    conditions.slotRules = normalizeCalendarRules([...(conditions.slotRules ?? []), ...newRules]);
    get('layer-conditions').checked = true;
    save();
    queueSolve();
  }
  function addCalendarRule(rule) { addCalendarRules([rule]); }

  function fillPeople(block, time, names, emptyText, actions = null) {
    const heading = document.createElement('strong');
    heading.textContent = names ? `${time}（${names.length}人）` : time;
    block.replaceChildren(heading);
    if (names?.length) {
      const list = document.createElement('ul');
      for (const name of names) {
        const person = document.createElement('li');
        if (actions) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'person-action';
          button.dataset.shiftAction = actions.type;
          button.dataset.date = actions.date;
          button.dataset.time = time;
          button.dataset.name = name;
          button.textContent = name;
          const fixed = calendarRules().some((rule) => rule.date === actions.date && rule.time === time &&
            (actions.type === 'require'
              ? (rule.type === 'require' && rule.name === name) || (rule.type === 'replace' && rule.to === name)
              : (rule.type === 'forbid' && rule.name === name) || (rule.type === 'replace' && rule.from === name)));
          button.classList.toggle('rule-applied', fixed);
          button.setAttribute('aria-label', actions.type === 'require'
            ? `${actions.date} ${time}に${name}を出勤させる条件を追加`
            : `${actions.date} ${time}の${name}について出勤変更メニューを開く`);
          button.classList.toggle('selected-person', name === selectedStaff);
          person.append(button);
        } else {
          person.textContent = name;
          person.classList.toggle('selected-person', name === selectedStaff);
        }
        list.append(person);
      }
      block.append(list);
    } else {
      const empty = document.createElement('p');
      empty.textContent = emptyText;
      block.append(empty);
    }
  }
  function fillAttendance(block) {
    const names = assignments?.[`${block.dataset.date} ${block.dataset.time}`];
    const empty = names ? '出勤者なし' : ({
      empty: '未設定', pending: '検索待ち', running: '検索中',
      unsat: '候補なし', invalid: '条件を確認', error: '検索エラー',
    }[solveState] ?? '未設定');
    fillPeople(block, block.dataset.time, names, empty, names ? { type: 'attendance', date: block.dataset.date } : null);
  }
  function refreshResults({ schedule = true } = {}) {
    if (schedule) get('calendar-days').querySelectorAll('.attendance-slot').forEach(fillAttendance);
    get('schedule-status').textContent = solveMessage;
    get('clingcon-status').textContent = {
      empty: '勤務希望未読込', pending: '検索待ち', running: '検索中',
      sat: problem?.optimized && !solutionOptimal ? '暫定候補' : `${solutions.length}件の解`, unsat: '候補なし', invalid: '条件の選択待ち', error: 'エラー',
    }[solveState];
    if (schedule) renderStats();
    renderExploration();
  }

  function currentGoodCandidates() {
    const saved = goodCandidates[monthKey()];
    return problem && !problem.errors.length && saved?.context === problem.context ? saved : null;
  }

  function candidateKey(candidate) {
    let key = assignmentKeys.get(candidate);
    if (!key) {
      key = JSON.stringify(problem.slots.map((slot) => [...(candidate[`${slot.date} ${slot.time}`] ?? [])].sort()));
      assignmentKeys.set(candidate, key);
    }
    return key;
  }

  function selectedCandidate() {
    const saved = currentGoodCandidates();
    return saved?.candidates.find((candidate) => candidate.id === saved.selectedId);
  }

  function renderExploration() {
    const candidate = solutions[solutionIndex];
    const saved = currentGoodCandidates();
    get('solution-position').textContent = candidate ? `解 ${solutionIndex + 1} / ${solutions.length}` : '解は未取得です。';
    const slider = get('solution-slider');
    slider.max = Math.max(1, solutions.length - 1);
    slider.value = solutionIndex;
    slider.disabled = solutions.length < 2;
    const goodByKey = new Map((saved?.candidates ?? []).map((item) => [candidateKey(item.assignments), item.id]));
    const currentGoodId = candidate ? goodByKey.get(candidateKey(candidate.assignments)) : undefined;
    slider.setAttribute('aria-valuetext', candidate ? `解 ${solutionIndex + 1} / ${solutions.length}${currentGoodId !== undefined ? `、良い候補 ${currentGoodId}` : ''}` : '解は未取得です。');
    const marks = document.createDocumentFragment();
    solutions.forEach((item, index) => {
      const id = goodByKey.get(candidateKey(item.assignments));
      if (id === undefined) return;
      const mark = document.createElement('span');
      mark.className = 'solution-mark';
      mark.textContent = '◆';
      mark.style.left = `${solutions.length > 1 ? index / (solutions.length - 1) * 100 : 0}%`;
      mark.title = `解 ${index + 1}：良い候補 ${id}`;
      mark.setAttribute('role', 'img');
      mark.setAttribute('aria-label', mark.title);
      marks.append(mark);
    });
    get('solution-marks').replaceChildren(marks);
    const marked = candidate && saved?.candidates.some((item) => candidateKey(item.assignments) === candidateKey(candidate.assignments));
    get('mark-solution').disabled = !candidate || marked;
    get('mark-solution').textContent = marked ? '良い候補に追加済み' : '良い候補に追加';
    const table = document.createDocumentFragment();
    const caption = document.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent = '今の候補と良い候補のソート設定と実績';
    table.append(caption);
    const head = document.createElement('thead');
    const headers = document.createElement('tr');
    const corner = document.createElement('th');
    corner.scope = 'col';
    corner.textContent = 'ソート項目';
    headers.append(corner);
    const current = document.createElement('th');
    current.scope = 'col';
    current.className = 'selected-candidate';
    const currentTitle = document.createElement('span');
    currentTitle.textContent = '今の候補';
    const currentLabel = document.createElement('p');
    currentLabel.className = 'help';
    currentLabel.textContent = assignments
      ? (selectedCandidate() ? `良い候補 ${selectedCandidate().id}を表示中` : `解 ${solutionIndex + 1} / ${solutions.length}を表示中`)
      : '候補は未取得です。';
    current.append(currentTitle, currentLabel);
    headers.append(current);
    for (const item of saved?.candidates ?? []) {
      const row = document.createElement('th');
      row.scope = 'col';
      row.classList.toggle('selected-candidate', saved.selectedId === item.id);
      const label = document.createElement('span');
      label.textContent = `良い候補 ${item.id}`;
      row.append(label);
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'secondary';
      select.dataset.candidate = item.id;
      select.dataset.action = 'select';
      const selected = saved.selectedId === item.id;
      select.textContent = selected ? '表示中' : '表示';
      select.setAttribute('aria-pressed', String(selected));
      select.setAttribute('aria-label', `良い候補 ${item.id}を表示`);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.dataset.candidate = item.id;
      remove.dataset.action = 'remove';
      remove.textContent = '削除';
      remove.setAttribute('aria-label', `良い候補 ${item.id}を削除`);
      const actions = document.createElement('div');
      actions.className = 'candidate-actions';
      actions.append(select, remove);
      row.append(actions);
      headers.append(row);
    }
    head.append(headers);
    table.append(head);
    const body = document.createElement('tbody');
    const goals = problem?.goals ?? ShiftScheduler.goals(sortSettings());
    const active = goals.order.filter((key) => goals[key].enabled);
    for (const key of active) {
      const row = document.createElement('tr');
      const label = document.createElement('th');
      label.scope = 'row';
      label.textContent = goalRules.find((rule) => rule.key === key).label;
      row.append(label);
      const currentValues = document.createElement('td');
      currentValues.className = 'selected-candidate';
      if (assignments && problem) currentValues.append(sortDetails(assignments, key, goals[key]));
      else currentValues.textContent = '未設定';
      row.append(currentValues);
      for (const item of saved?.candidates ?? []) {
        const cell = document.createElement('td');
        cell.classList.toggle('selected-candidate', saved.selectedId === item.id);
        cell.append(sortDetails(item.assignments, key, goals[key]));
        row.append(cell);
      }
      body.append(row);
    }
    if (!active.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = (saved?.candidates.length ?? 0) + 2;
      cell.textContent = '有効なソート項目はありません。';
      row.append(cell);
      body.append(row);
    }
    table.append(body);
    get('good-candidates').replaceChildren(table);
    get('good-candidates').closest('.candidate-comparison-scroll').hidden = !assignments && !saved?.candidates.length;
    get('good-candidates-empty').hidden = Boolean(saved?.candidates.length);
    get('sort-comparison-note').hidden = !assignments && !saved?.candidates.length;
  }

  function applyCandidateSelection() {
    const selected = selectedCandidate();
    if (selected) {
      const key = candidateKey(selected.assignments);
      const index = solutions.findIndex((candidate) => candidateKey(candidate.assignments) === key);
      if (index >= 0) solutionIndex = index;
    }
    assignments = selected?.assignments ?? solutions[solutionIndex]?.assignments ?? null;
    solveMessage = selected
      ? `良い候補 ${selected.id}を「出勤」レイヤーとスタッツに表示しています。`
      : assignments ? `解 ${solutionIndex + 1} / ${solutions.length}を「出勤」レイヤーとスタッツに表示しています。`
      : '条件を満たす候補がありません。';
  }

  function sortSolutions(previewKey) {
    for (const candidate of solutions) {
      const cached = assignmentScores.get(candidate.assignments);
      if (cached?.signature === scoreSignature) candidate.costs = cached.costs;
      else {
        candidate.costs = ShiftScheduler.score(candidate.assignments, problem);
        assignmentScores.set(candidate.assignments, { signature: scoreSignature, costs: candidate.costs });
      }
    }
    solutions.sort((a, b) => {
      for (let index = 0; index < a.costs.length; index++) {
        const difference = a.costs[index] - b.costs[index];
        if (difference) return difference;
      }
      return 0;
    });
    if (solutions.length > maxRetainedSolutions) solutions.length = maxRetainedSolutions;
    solutionKeys = new Set(solutions.map((candidate) => candidateKey(candidate.assignments)));
    const index = previewKey ? solutions.findIndex((candidate) => candidateKey(candidate.assignments) === previewKey) : -1;
    solutionIndex = index >= 0 ? index : 0;
  }

  function startSolve(runRevision) {
    if (runRevision !== revision || !problem || problem.errors.length || explorationExhausted || solveState === 'running') return;
    const input = { ...problem };
    get('clingcon-input').value = input.program;
    get('clingcon-options').textContent = input.options;
    get('clingcon-exit-code').textContent = '未実行';
    get('exploration-status').textContent = 'バックグラウンドで探索中です…';
    runSolver(input, runRevision);
  }

  function renderStats() {
    get('stats-month').textContent = `${month.getFullYear()}年${month.getMonth() + 1}月の集計`;
    const { days, names } = monthData();
    const rows = document.createDocumentFragment();
    for (const name of names) {
      const row = document.createElement('tr');
      const label = document.createElement('th');
      label.scope = 'row';
      label.textContent = name;
      row.append(label);
      const possible = days.filter(([, slots]) => slots.some((slot) => slot.names.includes(name))).length;
      const worked = assignments ? `${days.filter(([date, slots]) => slots.some((slot) =>
        assignments[`${date} ${slot.time}`]?.includes(name))).length}日` : '未設定';
      const workCount = assignments ? `${days.reduce((sum, [date, slots]) => sum + slots.filter((slot) =>
        assignments[`${date} ${slot.time}`]?.includes(name)).length, 0)}回` : '未設定';
      for (const value of [`${possible}日`, worked, workCount, '未設定']) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      rows.append(row);
    }
    if (!names.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'empty-state';
      cell.textContent = 'この月の勤務希望を読み込むと、スタッフ別の集計を表示します。';
      row.append(cell);
      rows.append(row);
    }
    get('stats-body').replaceChildren(rows);
  }

  function sortDetails(candidate, key, goal) {
    const counts = problem.names.map((name) => ({ name, count: problem.slots.filter((slot) => candidate[`${slot.date} ${slot.time}`]?.includes(name)).length }));
      const values = document.createElement('dl');
      values.className = 'candidate-values';
      function addValue(text, result) {
        const row = document.createElement('div');
        const label = document.createElement('dt');
        label.textContent = text;
        const value = document.createElement('dd');
        value.textContent = result;
        row.append(label, value);
        values.append(row);
      }
      const min = counts.length ? Math.min(...counts.map((item) => item.count)) : 0;
      const max = counts.length ? Math.max(...counts.map((item) => item.count)) : 0;
      const staffAt = (count) => counts.filter((item) => item.count === count).map((item) => item.name).join('、');
      if (key === 'workCount') {
        addValue('設定した範囲', `${goal.min}〜${goal.max}回`);
        addValue('実際の最小回数', counts.length ? `${min}回（${staffAt(min)}）` : '対象なし');
        addValue('実際の最大回数', counts.length ? `${max}回（${staffAt(max)}）` : '対象なし');
        addValue('範囲外のスタッフ', `${counts.filter((item) => item.count < goal.min || item.count > goal.max).length}人`);
      } else if (key === 'workBalance') {
        addValue('許容する差', `${goal.max}回`);
        addValue('実際の最大の差', counts.length >= 2 ? `${max - min}回` : '比較対象が2人未満です。');
        addValue('最悪の組み合わせ', counts.length < 2 ? '比較対象が2人未満です。' : max === min
          ? `全員${max}回（差0回）`
          : `${staffAt(max)}：${max}回 ／ ${staffAt(min)}：${min}回`);
      } else if (key === 'workInterval') {
        addValue('設定した範囲', `${goal.min}〜${goal.max}日`);
        const gaps = [];
        for (const name of problem.names) {
          const days = [...new Set(problem.slots.filter((slot) => candidate[`${slot.date} ${slot.time}`]?.includes(name)).map((slot) => slot.date))].sort();
          for (let index = 1; index < days.length; index++) gaps.push({ name, from: days[index - 1], to: days[index], gap: Number(days[index].slice(-2)) - Number(days[index - 1].slice(-2)) });
        }
        const describeGap = (gap) => `${gap.gap}日（${gap.name}：${gap.from} → ${gap.to}）`;
        gaps.sort((a, b) => a.gap - b.gap);
        const empty = '連続する出勤日がありません。';
        addValue('実際の最短間隔', gaps.length ? describeGap(gaps[0]) : empty);
        addValue('実際の最長間隔', gaps.length ? describeGap(gaps.at(-1)) : empty);
        addValue('範囲外の間隔', `${gaps.filter((gap) => gap.gap < goal.min || gap.gap > goal.max).length}件`);
      } else {
        const possible = problem.possibleCounts.filter((count) => count > 0);
        const fewest = possible.length ? Math.min(...possible) : 0;
        const scarce = counts.filter((_, index) => problem.possibleCounts[index] === fewest && fewest > 0);
        const score = ShiftScheduler.score(candidate, problem)[problem.goals.order.indexOf(key) * 2];
        addValue('優先する先生の出勤可能回数', possible.length ? `${fewest}回` : '出勤可能な先生がいません。');
        addValue('対象と出勤回数', scarce.map((item) => `${item.name}：出勤${item.count}回／可能${fewest}回`).join('、') || '対象なし');
        addValue('未割り当ての評価値', `${score}（小さいほど優先）`);
      }
      if (goal.trend !== 'neutral') addValue('設定した傾向', goalRules.find((rule) => rule.key === key).trends.find(([value]) => value === goal.trend)[1]);
    return values;
  }

  function renderCalendar() {
    const year = month.getFullYear();
    const index = month.getMonth();
    const title = `${year}年${index + 1}月`;
    const visibleWeekdays = new Set();
    const data = monthData();
    get('staff-highlight').hidden = !selectedStaff;
    get('staff-highlight').textContent = selectedStaff ? `${selectedStaff}の出勤可能なコマを強調表示しています。` : '';
    if (hasMonth()) {
      for (const [date, slots] of data.days) {
        if (slots.some((slot) => slot.names.length)) visibleWeekdays.add(new Date(`${date}T00:00:00`).getDay());
      }
    } else {
      for (let weekday = 0; weekday < 7; weekday++) visibleWeekdays.add(weekday);
    }
    const table = get('calendar-days').closest('table');
    table.hidden = visibleWeekdays.size === 0;
    get('calendar-empty').hidden = visibleWeekdays.size > 0;
    table.style.setProperty('--weekday-count', visibleWeekdays.size || 7);
    table.querySelectorAll('thead th').forEach((heading, weekday) => {
      heading.hidden = !visibleWeekdays.has(weekday);
      heading.classList.toggle('sunday', weekday === 0);
      heading.classList.toggle('saturday', weekday === 6);
    });
    const layers = [
      { key: 'availability', label: '出勤可能' },
      { key: 'attendance', label: '出勤' },
      { key: 'conditions', label: '条件' },
    ].filter((layer) => get(`layer-${layer.key}`).checked);
    table.style.setProperty('--layer-count', layers.length || 1);
    table.style.setProperty('--day-min-width', `${layers.reduce((width, layer) => width + (layer.key === 'conditions' ? 160 : 120), 0) || 80}px`);
    get('calendar-state').textContent = layers.length ? layers.map((layer) => layer.label).join(' / ') : 'レイヤー非表示';
    get('calendar-note').textContent = hasMonth()
      ? `${sourceName}：出勤は条件・目標から検索した候補です。スタッフ名を選ぶと、出勤固定・出勤禁止・交代の条件を追加できます。人数条件は勤務枠ごとに設定できます。`
      : 'この月の勤務希望を読み込んでください。';
    get('month-title').textContent = title;
    get('calendar-caption').textContent = `${title}のシフトカレンダー`;
    const firstDay = month.getDay();
    const days = new Date(year, index + 1, 0).getDate();
    const rows = document.createDocumentFragment();
    for (let week = 0; week < Math.ceil((firstDay + days) / 7); week++) {
      const row = document.createElement('tr');
      for (let weekday = 0; weekday < 7; weekday++) {
        if (!visibleWeekdays.has(weekday)) continue;
        const day = week * 7 + weekday - firstDay + 1;
        const cell = document.createElement('td');
        if (weekday === 0) cell.classList.add('sunday');
        if (weekday === 6) cell.classList.add('saturday');
        if (day < 1 || day > days) {
          cell.classList.add('empty');
        } else {
          const date = document.createElement('time');
          date.className = 'day-number';
          date.dateTime = `${year}-${String(index + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          date.textContent = day;
          cell.append(date);
          if (year === today.getFullYear() && index === today.getMonth() && day === today.getDate()) {
            cell.classList.add('today');
            date.setAttribute('aria-current', 'date');
            const label = document.createElement('span');
            label.className = 'today-label';
            label.textContent = '今日';
            cell.append(label);
          }
          const slots = availability?.days[date.dateTime];
          if (layers.length) {
            const content = document.createElement('div');
            content.className = 'day-layers';
            const headings = document.createElement('div');
            headings.className = 'layer-row layer-headings';
            for (const layer of layers) {
              const label = document.createElement('span');
              label.className = `layer-column ${layer.key}-layer`;
              label.textContent = layer.label;
              headings.append(label);
            }
            content.append(headings);
            if (hasMonth() && slots?.length) {
              slots.forEach((slot) => {
                const slotRow = document.createElement('div');
                slotRow.className = 'layer-row slot-row';
                for (const layer of layers) {
                  const block = document.createElement('div');
                  block.className = `layer-column ${layer.key}-slot`;
                  if (layer.key === 'availability') {
                    fillPeople(block, slot.time, slot.names, '出勤可能者なし',
                      { type: 'require', date: date.dateTime });
                    block.classList.toggle('staff-available', Boolean(selectedStaff && slot.names.includes(selectedStaff)));
                  } else if (layer.key === 'attendance') {
                    block.dataset.date = date.dateTime;
                    block.dataset.time = slot.time;
                    fillAttendance(block);
                  } else {
                    block.append(makeSlotControls(date.dateTime, slot.time, slot.names.length));
                    block.append(makeSlotConditions(date.dateTime, slot.time));
                  }
                  slotRow.append(block);
                }
                content.append(slotRow);
              });
            } else {
              const empty = document.createElement('span');
              empty.className = 'no-slots';
              empty.textContent = hasMonth() ? '勤務枠なし' : '勤務希望未読込';
              content.append(empty);
            }
            cell.append(content);
          }
        }
        row.append(cell);
      }
      if (row.querySelector('time')) rows.append(row);
    }
    get('calendar-days').replaceChildren(rows);
    refreshResults();
  }

  function failSolve(message, runRevision) {
    if (runRevision !== revision) return;
    worker?.terminate();
    worker = null;
    clearTimeout(solveTimer);
    clearTimeout(progressTimer);
    progressTimer = null;
    pendingWitnesses = [];
    assignments = selectedCandidate()?.assignments ?? solutions[solutionIndex]?.assignments ?? null;
    solveState = 'error';
    solveMessage = `検索できませんでした：${message}`;
    get('clingcon-stderr').value += `${get('clingcon-stderr').value ? '\n' : ''}${message}`;
    refreshResults();
  }
  function flushWitnesses(input, runRevision) {
    clearTimeout(progressTimer);
    progressTimer = null;
    if (runRevision !== revision || !pendingWitnesses.length) return;
    const witnesses = pendingWitnesses;
    pendingWitnesses = [];
    const previousAssignments = assignments;
    const previewKey = solutions[solutionIndex] ? candidateKey(solutions[solutionIndex].assignments) : null;
    for (const witness of witnesses) {
      exploredSolutions++;
      const candidate = ShiftScheduler.readWitness(witness, input);
      const key = candidateKey(candidate.assignments);
      if (!solutionKeys.has(key)) {
        solutions.push(candidate);
        solutionKeys.add(key);
      }
    }
    sortSolutions(previewKey);
    applyCandidateSelection();
    solveMessage = assignments
      ? `${exploredSolutions}件を探索し、上位${solutions.length}件を保持しています。探索とソートを継続しています…`
      : 'シフト候補を探索しています…';
    refreshResults({ schedule: assignments !== previousAssignments });
  }
  function receiveWitnesses(witnesses, input, runRevision) {
    if (runRevision !== revision) return;
    pendingWitnesses.push(...witnesses);
    if (!progressTimer) progressTimer = setTimeout(() => {
      try { flushWitnesses(input, runRevision); }
      catch (error) { failSolve(error.message, runRevision); }
    }, 500);
  }
  function finishSolve(result, input, runRevision) {
    if (runRevision !== revision) return;
    worker?.terminate();
    worker = null;
    get('clingcon-stdout').value = result.stdout;
    get('clingcon-stderr').value = result.stderr;
    get('clingcon-exit-code').textContent = result.exitCode ?? '取得できませんでした';
    try {
      flushWitnesses(input, runRevision);
      if (result.error) throw new Error(result.error);
      if (![0, 10, 20, 30].includes(result.exitCode)) throw new Error(`Clingcon の終了コード：${result.exitCode}`);
      const parsed = result.streamed ? {
        assignments: solutions[0]?.assignments ?? null,
        candidates: [],
        optimal: result.resultName === 'OPTIMUM FOUND',
        exhausted: result.more === 'no' || result.resultName === 'UNSATISFIABLE',
      } : ShiftScheduler.readResult(result.stdout, input);
      explorationExhausted = parsed.exhausted;
      const previewKey = solutions[solutionIndex] ? candidateKey(solutions[solutionIndex].assignments) : null;
      const existing = new Set(solutions.map((candidate) => candidateKey(candidate.assignments)));
      for (const candidate of parsed.candidates) {
        const key = candidateKey(candidate.assignments);
        if (!existing.has(key)) { solutions.push(candidate); existing.add(key); }
      }
      sortSolutions(previewKey);
      solutionOptimal = parsed.optimal;
      if (explorationExhausted && solutions.length) solutionOptimal = true;
      applyCandidateSelection();
      solveState = assignments ? 'sat' : explorationExhausted ? 'unsat' : 'pending';
      get('exploration-status').textContent = explorationExhausted
        ? `${exploredSolutions}件を探索し、上位${solutions.length}件を保持しました。探索は完了しています。`
        : `${exploredSolutions}件を探索し、上位${solutions.length}件を保持しました。`;
      if (!assignments && !explorationExhausted) solveMessage = 'シフト候補を探索中です…';
      refreshResults();
    } catch (error) { failSolve(error.message, runRevision); }
  }
  function loadFactory() {
    // file:// does not support a normal Worker in some browsers. Keep the
    // existing single-file WASM build usable when index.html is opened directly.
    if (!factoryPromise) factoryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './dist/clingcon-demo.js';
      script.onload = resolve;
      script.onerror = () => { factoryPromise = null; reject(new Error('Clingcon の WASM を読み込めませんでした。')); };
      document.head.append(script);
    });
    return factoryPromise;
  }
  async function runSolver(input, runRevision) {
    if (runRevision !== revision) return;
    solveState = 'running';
    solveMessage = selectedCandidate()
      ? `良い候補 ${selectedCandidate().id}を表示しています。別の解を検索しています…`
      : 'シフト候補を検索しています…';
    refreshResults();
    try {
      if (location.protocol !== 'file:') {
        worker = new Worker('./solver-worker.js');
        worker.onmessage = ({ data }) => {
          if (data.progress) receiveWitnesses(data.progress, input, runRevision);
          else finishSolve(data, input, runRevision);
        };
        worker.onerror = (event) => failSolve(event.message || 'Clingcon を読み込めませんでした。', runRevision);
        worker.postMessage({ program: input.program, options: input.options });
      } else {
        await loadFactory();
        if (runRevision !== revision) return;
        const stdout = [];
        const stderr = [];
        const module = await createClingconDemo({
          noInitialRun: true,
          print: (line) => stdout.push(String(line)),
          printErr: (line) => stderr.push(String(line)),
        });
        if (runRevision !== revision) return;
        const exitCode = module.ccall('clingcon_run', 'number', ['string', 'string'], [input.program, input.options]);
        finishSolve({ exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') }, input, runRevision);
      }
    } catch (error) { failSolve(error.message || String(error), runRevision); }
  }
  function queueSolve(redraw = true) {
    clearTimeout(solveTimer);
    clearTimeout(progressTimer);
    progressTimer = null;
    pendingWitnesses = [];
    worker?.terminate();
    worker = null;
    revision++;
    const previousProblem = problem;
    const previewKey = solutions[solutionIndex] ? candidateKey(solutions[solutionIndex].assignments) : null;
    assignments = null;
    solutionOptimal = false;
    problem = hasMonth() ? ShiftScheduler.build(availability, monthKey(), dayConditions, groups(), sortSettings()) : null;
    scoreSignature = problem ? JSON.stringify(problem.goals) : '';
    if (!problem || problem.context !== previousProblem?.context) {
      solutions = [];
      solutionKeys = new Set();
      solutionIndex = 0;
      explorationExhausted = false;
    }
    const existing = new Set(solutions.map((candidate) => candidateKey(candidate.assignments)));
    for (const candidate of currentGoodCandidates()?.candidates ?? []) {
      const key = candidateKey(candidate.assignments);
      if (!existing.has(key)) { solutions.push({ assignments: candidate.assignments, costs: [] }); existing.add(key); }
    }
    if (problem) sortSolutions(previewKey);
    exploredSolutions = solutions.length;
    assignments = selectedCandidate()?.assignments ?? solutions[solutionIndex]?.assignments ?? null;
    get('exploration-status').textContent = '';
    get('clingcon-input').value = problem?.program ?? '';
    get('clingcon-stdout').value = '';
    get('clingcon-stderr').value = problem?.errors.join('\n') ?? '';
    get('clingcon-options').textContent = problem?.options ?? '未設定';
    get('clingcon-exit-code').textContent = '未実行';
    solveState = !problem ? 'empty' : problem.errors.length ? 'invalid' : explorationExhausted ? (solutions.length ? 'sat' : 'unsat') : 'pending';
    solveMessage = selectedCandidate() ? `良い候補 ${selectedCandidate().id}を表示しています。新しい解を検索します…`
      : !problem ? 'この月の勤務希望を読み込むと、シフト候補を検索します。'
      : problem.errors.length ? problem.errors.join(' ') : '条件を更新しました。シフト候補を検索します…';
    if (redraw) renderCalendar();
    else refreshResults();
    if (solveState === 'pending') {
      const runRevision = revision;
      solveTimer = setTimeout(() => startSolve(runRevision), 300);
    } else if (explorationExhausted && problem && !problem.errors.length) {
      applyCandidateSelection();
      get('exploration-status').textContent = `${solutions.length}件の解を取得しました。探索は完了しています。`;
      refreshResults();
    }
  }

  function changeMonth(offset) {
    month = new Date(month.getFullYear(), month.getMonth() + offset, 1);
    closeStaffForm();
    get('staff-status').textContent = '';
    renderStaff();
    renderGroups();
    queueSolve();
    save();
  }
  get('previous-month').addEventListener('click', () => changeMonth(-1));
  get('next-month').addEventListener('click', () => changeMonth(1));
  get('current-month').addEventListener('click', () => {
    const now = new Date();
    month = new Date(now.getFullYear(), now.getMonth(), 1);
    closeStaffForm();
    get('staff-status').textContent = '';
    renderStaff();
    renderGroups();
    queueSolve();
    save();
  });
  for (const id of ['layer-availability', 'layer-attendance', 'layer-conditions']) {
    get(id).addEventListener('change', () => { renderCalendar(); save(); });
  }
  get('calendar-days').addEventListener('input', (event) => {
    const input = event.target;
    const controls = input.closest('.slot-condition');
    if (!controls || input.type !== 'range') return;
    const date = controls.dataset.date;
    const time = controls.dataset.time;
    const slot = (availability?.days[date] ?? []).find((item) => item.time === time);
    const limits = { ...ShiftScheduler.limits(dayConditions, date, time, slot?.names.length), [input.dataset.bound]: Number(input.value) };
    if (limits.min > limits.max) {
      if (input.dataset.bound === 'min') limits.max = limits.min;
      else limits.min = limits.max;
    }
    dayConditions[`${date} ${time}`] = limits;
    syncSlotRange(controls, limits);
    controls.querySelector('.condition-warning').textContent = conditionWarning(date, time, limits);
    save();
    queueSolve(false);
  });
  get('calendar-days').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.removeSlotRule !== undefined) {
      const conditions = monthConditions[monthKey()] ??= {};
      const rules = conditions.slotRules ?? [];
      const index = Number(button.dataset.removeSlotRule);
      if (Number.isInteger(index) && rules[index]) rules.splice(index, 1);
      save();
      queueSolve();
      return;
    }
    if (button.dataset.ruleAction) {
      const base = { date: button.dataset.date, time: button.dataset.time };
      if (button.dataset.ruleAction === 'forbid') {
        addCalendarRule({ ...base, type: 'forbid', name: button.dataset.name });
      } else {
        addCalendarRules([
          { ...base, type: 'forbid', name: button.dataset.name },
          { ...base, type: 'require', name: button.dataset.to },
        ]);
      }
      return;
    }
    if (button.dataset.shiftAction === 'require') {
      addCalendarRule({ type: 'require', date: button.dataset.date, time: button.dataset.time, name: button.dataset.name });
      return;
    }
    if (button.dataset.shiftAction !== 'attendance') return;
    const listItem = button.closest('li');
    const wasOpen = listItem.querySelector('.shift-action-menu');
    get('calendar-days').querySelectorAll('.shift-action-menu').forEach((menu) => menu.remove());
    if (wasOpen) return;
    const { date, time, name } = button.dataset;
    const menu = document.createElement('div');
    menu.className = 'shift-action-menu';
    const title = document.createElement('strong');
    title.textContent = `${name}の勤務を変更`;
    menu.append(title);
    const forbid = document.createElement('button');
    forbid.type = 'button';
    forbid.className = 'secondary';
    forbid.dataset.ruleAction = 'forbid';
    forbid.dataset.date = date;
    forbid.dataset.time = time;
    forbid.dataset.name = name;
    forbid.textContent = '出勤しない';
    menu.append(forbid);
    const available = availability?.days[date]?.find((slot) => slot.time === time)?.names ?? [];
    const working = assignments?.[`${date} ${time}`] ?? [];
    const replacements = available.filter((candidate) => candidate !== name && !working.includes(candidate));
    if (replacements.length) {
      const note = document.createElement('span');
      note.textContent = '交代する：';
      menu.append(note);
      for (const candidate of replacements) {
        const replace = document.createElement('button');
        replace.type = 'button';
        replace.className = 'secondary';
        replace.dataset.ruleAction = 'replace';
        replace.dataset.date = date;
        replace.dataset.time = time;
        replace.dataset.name = name;
        replace.dataset.to = candidate;
        replace.textContent = candidate;
        replace.setAttribute('aria-label', `${name}から${candidate}へ交代する条件を追加`);
        menu.append(replace);
      }
    } else {
      const note = document.createElement('span');
      note.textContent = '交代できる未出勤スタッフはいません。';
      menu.append(note);
    }
    listItem.append(menu);
    forbid.focus();
  });
  get('group-conditions').addEventListener('change', (event) => {
    const input = event.target;
    if (input.dataset.monthCondition !== undefined) {
      const conditions = monthConditions[monthKey()] ??= {};
      conditions[input.dataset.monthCondition] = { enabled: input.checked };
      save();
      queueSolve(false);
      return;
    }
    if (input.dataset.exactCountToggle !== undefined) {
      const name = input.dataset.exactCountToggle;
      const conditions = monthConditions[monthKey()] ??= {};
      const exact = conditions.exactWorkCounts ??= { counts: {} };
      const range = get('group-conditions').querySelector(`input[data-exact-count-staff="${CSS.escape(name)}"]`);
      range.disabled = !input.checked;
      if (input.checked) exact.counts[name] = Number(range.value);
      else delete exact.counts[name];
      save();
      queueSolve(false);
      return;
    }
    const key = input.dataset.group;
    if (!key) return;
    const conditions = monthConditions[monthKey()] ??= {};
    const group = conditions[key] ??= { enabled: false, names: [] };
    if (input.dataset.staff !== undefined) {
      const names = new Set(group.names);
      if (input.checked) names.add(input.dataset.staff);
      else names.delete(input.dataset.staff);
      group.names = [...names];
      get(`group-summary-${key}`).textContent = `対象スタッフを選択（${group.names.length}人選択中）`;
    } else group.enabled = input.checked;
    save();
    queueSolve(false);
  });
  get('group-conditions').addEventListener('input', (event) => {
    const input = event.target;
    const name = input.dataset.exactCountStaff;
    if (name === undefined) return;
    const value = Number(input.value);
    input.setAttribute('aria-valuetext', `${value}回`);
    const output = get('group-conditions').querySelector(`output[data-exact-count-output="${CSS.escape(name)}"]`);
    output.textContent = `${value}回`;
    const conditions = monthConditions[monthKey()] ??= {};
    const exact = conditions.exactWorkCounts ??= { counts: {} };
    exact.counts[name] = value;
    save();
    queueSolve(false);
  });
  async function importWorkbook(buffer, name) {
    const data = await readShiftWorkbook(buffer);
    workbookAvailability = data;
    applyManualStaff();
    sourceName = name;
    if (!data.months.includes(monthKey())) {
      const [year, index] = data.months.at(-1).split('-').map(Number);
      month = new Date(year, index - 1, 1);
    }
    get('file-status').textContent = `読込済み：${name}（${data.months.length}か月）`;
    closeStaffForm();
    get('staff-status').textContent = '';
    renderStaff();
    renderGroups();
    queueSolve();
    save();
  }

  get('excel-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const field = event.target;
    field.disabled = true;
    get('file-status').textContent = '勤務表を読み込んでいます…';
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('.xlsx ファイルを選択してください。');
      if (file.size > 50 * 1024 * 1024) throw new Error('50 MB 以下のファイルを選択してください。');
      await importWorkbook(await file.arrayBuffer(), file.name);
      field.removeAttribute('aria-invalid');
    } catch (error) {
      get('file-status').textContent = `読み込めませんでした：${error.message}。表示中のデータは変更していません。`;
      field.setAttribute('aria-invalid', 'true');
    } finally { field.disabled = false; field.value = ''; }
  });
  get('show-staff-form').addEventListener('click', showStaffForm);
  get('staff-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-staff]');
    if (!button) return;
    selectedStaff = selectedStaff === button.dataset.staff ? '' : button.dataset.staff;
    if (selectedStaff) get('layer-availability').checked = true;
    renderStaff();
    renderCalendar();
    save();
    get('staff-list').querySelectorAll('button').forEach((candidate) => {
      if (candidate.dataset.staff === button.dataset.staff) candidate.focus();
    });
  });
  get('sort-settings').addEventListener('change', (event) => {
    const input = event.target;
    const key = input.dataset.goal;
    if (!key) return;
    if (input.type === 'number' && !input.checkValidity()) { input.reportValidity(); return; }
    const settings = ShiftScheduler.goals(sortSettings());
    const goal = settings[key];
    const field = input.dataset.field;
    goal[field] = field === 'enabled' ? input.checked : ['min', 'max'].includes(field) ? Number(input.value) : input.value;
    if (goal.min !== undefined && goal.min > goal.max) {
      if (field === 'min') goal.max = goal.min;
      else goal.min = goal.max;
      get(`goal-${key}-min`).value = goal.min;
      get(`goal-${key}-max`).value = goal.max;
    }
    monthSort[monthKey()] = settings;
    save();
    queueSolve(false);
  });
  get('sort-settings').addEventListener('click', (event) => {
    const button = event.target.closest('[data-move]');
    if (!button) return;
    const item = button.closest('.sort-item');
    const neighbor = button.dataset.move === 'up' ? item.previousElementSibling : item.nextElementSibling;
    if (!neighbor) return;
    if (button.dataset.move === 'up') item.parentNode.insertBefore(item, neighbor);
    else item.parentNode.insertBefore(item, neighbor.nextElementSibling);
    saveSortOrder();
    item.querySelector('.sort-handle').focus();
  });
  get('sort-settings').addEventListener('dragstart', (event) => {
    const handle = event.target.closest('.sort-handle');
    if (!handle) { event.preventDefault(); return; }
    draggedSort = handle.closest('.sort-item');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedSort.dataset.sort);
    draggedSort.classList.add('sort-dragging');
  });
  get('sort-settings').addEventListener('dragover', (event) => {
    if (!draggedSort) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const target = event.target.closest('.sort-item');
    get('sort-settings').querySelectorAll('.sort-item').forEach((item) => {
      item.classList.remove('sort-drop-before', 'sort-drop-after');
    });
    if (!target || target === draggedSort) return;
    const bounds = target.getBoundingClientRect();
    target.classList.add(event.clientY < bounds.top + bounds.height / 2 ? 'sort-drop-before' : 'sort-drop-after');
  });
  get('sort-settings').addEventListener('drop', (event) => {
    if (!draggedSort) return;
    event.preventDefault();
    const target = event.target.closest('.sort-item');
    if (target && target !== draggedSort) {
      const bounds = target.getBoundingClientRect();
      const before = event.clientY < bounds.top + bounds.height / 2;
      target.parentNode.insertBefore(draggedSort, before ? target : target.nextElementSibling);
      saveSortOrder();
    }
    clearSortDrag();
  });
  get('sort-settings').addEventListener('dragend', clearSortDrag);
  function selectSolution(index) {
    if (index < 0 || index >= solutions.length) return;
    solutionIndex = index;
    const saved = currentGoodCandidates();
    if (saved) saved.selectedId = null;
    applyCandidateSelection();
    save();
    refreshResults();
  }
  get('solution-slider').addEventListener('input', (event) => selectSolution(Number(event.target.value)));
  get('mark-solution').addEventListener('click', () => {
    const candidate = solutions[solutionIndex];
    if (!candidate || !problem) return;
    let saved = currentGoodCandidates();
    if (!saved) saved = goodCandidates[monthKey()] = { context: problem.context, candidates: [], selectedId: null, nextId: 1 };
    if (saved.candidates.some((item) => candidateKey(item.assignments) === candidateKey(candidate.assignments))) return;
    const id = saved.nextId++;
    saved.candidates.push({ id, assignments: candidate.assignments });
    if (saved.selectedId === null) saved.selectedId = id;
    applyCandidateSelection();
    save();
    refreshResults();
  });
  get('good-candidates').addEventListener('click', (event) => {
    const button = event.target.closest('[data-candidate]');
    const saved = currentGoodCandidates();
    if (!button || !saved) return;
    const id = Number(button.dataset.candidate);
    if (button.dataset.action === 'select') saved.selectedId = id;
    else {
      saved.candidates = saved.candidates.filter((item) => item.id !== id);
      if (saved.selectedId === id) saved.selectedId = saved.candidates[0]?.id ?? null;
    }
    applyCandidateSelection();
    save();
    refreshResults();
  });
  get('cancel-staff').addEventListener('click', () => {
    closeStaffForm();
    get('show-staff-form').focus();
  });
  get('staff-name').addEventListener('input', () => get('staff-name').setCustomValidity(''));
  get('staff-add-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!hasMonth()) return;
    const field = get('staff-name');
    const name = field.value.trim();
    if (!name || monthData().names.includes(name)) {
      field.setCustomValidity(name ? '同じ名前のスタッフがいます。別の名前を入力してください。' : '名前を入力してください。');
      field.reportValidity();
      return;
    }
    const unavailable = Array.from(get('staff-unavailable').querySelectorAll('input:checked'), (input) => input.dataset.slot);
    (manualStaff[monthKey()] ??= []).push({ name, unavailable });
    applyManualStaff();
    closeStaffForm();
    renderStaff();
    renderGroups();
    save();
    queueSolve();
    get('staff-status').textContent = `${name}を表示月のスタッフに追加しました。`;
    get('show-staff-form').focus();
  });

  function validateStateFile(file) {
    const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
    const require = (valid) => { if (!valid) throw new Error('アプリの状態ファイルの形式が正しくありません。'); };
    const monthly = (value, check) => {
      require(record(value));
      for (const [key, item] of Object.entries(value)) {
        require(/^\d{4}-(0[1-9]|1[0-2])$/.test(key));
        check(item);
      }
    };
    require(record(file) && file.format === 'scheduler-state' && file.version === 1 && record(file.state));
    const state = file.state;
    require(Number.isInteger(state.year) && state.year >= 1900 && state.year <= 9999 && Number.isInteger(state.month) && state.month >= 0 && state.month <= 11);
    require(typeof state.sourceName === 'string' && typeof state.selectedStaff === 'string');
    require(record(state.layers) && ['availability', 'attendance', 'conditions'].every((key) => typeof state.layers[key] === 'boolean'));
    if (state.availability !== null) {
      const data = state.availability;
      require(record(data) && strings(data.months) && record(data.days) && record(data.staff));
      require(data.months.every((key) => /^\d{4}-(0[1-9]|1[0-2])$/.test(key)));
      monthly(data.staff, (names) => require(strings(names)));
      for (const [date, slots] of Object.entries(data.days)) {
        require(/^\d{4}-\d{2}-\d{2}$/.test(date) && data.months.includes(date.slice(0, 7)) && Array.isArray(slots));
        for (const slot of slots) require(record(slot) && /^\d{2}:\d{2}$/.test(slot.time) && strings(slot.names));
      }
    }
    monthly(state.manualStaff, (staff) => {
      require(Array.isArray(staff));
      for (const person of staff) require(record(person) && typeof person.name === 'string' && strings(person.unavailable));
    });
    require(record(state.conditions) && record(state.conditions.days));
    for (const [slot, limits] of Object.entries(state.conditions.days)) require(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(slot) && record(limits) && Number.isInteger(limits.min) && Number.isInteger(limits.max) && limits.min >= 0 && limits.max >= limits.min);
    monthly(state.conditions.months, (groups) => {
      require(record(groups));
      for (const rule of groupRules) {
        const group = groups[rule.key];
        if (group !== undefined) require(record(group) && typeof group.enabled === 'boolean' && strings(group.names));
      }
      if (groups.exactWorkCounts !== undefined) {
        require(record(groups.exactWorkCounts) && record(groups.exactWorkCounts.counts));
        for (const [name, count] of Object.entries(groups.exactWorkCounts.counts)) {
          require(typeof name === 'string' && Number.isInteger(count) && count >= 0);
        }
      }
      if (groups.continuousDailyShift !== undefined) {
        require(record(groups.continuousDailyShift) && typeof groups.continuousDailyShift.enabled === 'boolean');
      }
      if (groups.slotRules !== undefined) {
        require(Array.isArray(groups.slotRules));
        for (const rule of groups.slotRules) {
          require(record(rule) && ['require', 'forbid', 'replace'].includes(rule.type) &&
            /^\d{4}-\d{2}-\d{2}$/.test(rule.date) && /^\d{2}:\d{2}$/.test(rule.time));
          if (rule.type === 'replace') require(typeof rule.from === 'string' && typeof rule.to === 'string' && rule.from !== rule.to);
          else require(typeof rule.name === 'string');
        }
      }
    });
    monthly(state.sort, (settings) => {
      require(record(settings));
      if (settings.order !== undefined) require(strings(settings.order));
      for (const rule of goalRules) if (settings[rule.key] !== undefined) require(record(settings[rule.key]));
    });
    monthly(state.goodCandidates, (saved) => {
      require(record(saved) && typeof saved.context === 'string' && Array.isArray(saved.candidates) && Number.isInteger(saved.nextId) && saved.nextId > 0);
      const ids = new Set();
      for (const candidate of saved.candidates) {
        require(record(candidate) && Number.isInteger(candidate.id) && candidate.id > 0 && candidate.id < saved.nextId && !ids.has(candidate.id) && record(candidate.assignments));
        ids.add(candidate.id);
        for (const [slot, names] of Object.entries(candidate.assignments)) require(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(slot) && strings(names));
      }
      require(saved.selectedId === null || ids.has(saved.selectedId));
    });
    return state;
  }

  get('save-state-file').addEventListener('click', () => {
    try {
      const file = { format: 'scheduler-state', version: 1, savedAt: new Date().toISOString(), state: currentState() };
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `scheduler-state-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      get('state-file-status').textContent = '状態ファイルを保存するダウンロードを開始しました。';
    } catch (error) { get('state-file-status').textContent = `保存できませんでした：${error.message}`; }
  });
  get('load-state-file').addEventListener('change', async (event) => {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    input.disabled = true;
    get('state-file-status').textContent = '状態ファイルを読み込んでいます…';
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('50 MB 以下の状態ファイルを選択してください。');
      const state = validateStateFile(JSON.parse(await file.text()));
      clearTimeout(solveTimer);
      worker?.terminate();
      worker = null;
      revision++;
      solutions = [];
      solutionIndex = 0;
      problem = null;
      explorationExhausted = false;
      restoreState(state);
      applyManualStaff();
      closeStaffForm();
      clearSortDrag();
      get('staff-status').textContent = '';
      get('excel-file').value = '';
      get('excel-file').removeAttribute('aria-invalid');
      renderStaff();
      renderGroups();
      queueSolve();
      save();
      get('state-file-status').textContent = `読み込み済み：${file.name}。状態を復元し、候補を再探索します。`;
    } catch (error) { get('state-file-status').textContent = `読み込めませんでした：${error.message}`; }
    finally { input.disabled = false; input.value = ''; }
  });
  renderStaff();
  renderGroups();
  queueSolve();
  save();
})();
