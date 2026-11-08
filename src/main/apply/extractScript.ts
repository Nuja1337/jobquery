// Runs inside the application page (any frame) and lists its form fields.
// Kept as a plain JavaScript string so the bundler can't add helpers that don't exist in the page.
//
// Each field element gets a data-jp-id attribute so the filler can find it again in the same
// page session. Radio and checkbox groups also return one id per option.

export interface ExtractedField {
  key: string
  jpId: string
  label: string
  type: string
  required: boolean
  options: string[]
  optionIds: string[]
  placeholder: string | null
  maxLength: number | null
  fileHint: 'resume' | 'cover_letter' | 'other' | null
  /** The field already holds something: typed text, a chosen option, a ticked box or a file. */
  hasValue: boolean
}

export const EXTRACT_FIELDS_SCRIPT = String.raw`(() => {
  // Labels keep a trailing "*" until isRequired has seen it. clean() drops it for display. Lever
  // marks required questions with "✱" and puts helper text after it, so the label ends there.
  const tidy = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const clean = (s) => tidy(tidy(s).split('✱')[0]).replace(/\s*\*\s*$/, '').trim();
  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  let counter = Number(document.documentElement.dataset.jpCounter || '0');
  const idFor = (el) => {
    if (!el.dataset.jpId) { el.dataset.jpId = 'jp' + (counter++); }
    return el.dataset.jpId;
  };
  // Text of an element without SVG icons, whose fallback text ("SVGs not supported by this browser.") isn't a label.
  const textOf = (node) => {
    if (!node) return '';
    const copy = node.cloneNode(true);
    copy.querySelectorAll('svg').forEach((n) => n.remove());
    return (copy.textContent || '').replace(/SVGs not supported by this browser\.?/gi, ' ');
  };
  const textOfIds = (ids) => ids.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' ');

  const labelFor = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) { const t = tidy(textOfIds(labelledBy)); if (t) return t; }
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) { const t = tidy(textOf(lab)); if (t) return t; }
    }
    const wrap = el.closest('label');
    if (wrap) {
      // A wrapping label can hold a title element plus upload or status text. The title wins.
      const head = Array.from(wrap.querySelectorAll('[class*="label" i]')).find((n) => !n.contains(el) && !n.querySelector('input, select, textarea') && tidy(textOf(n)));
      if (head) return tidy(textOf(head));
      const copy = wrap.cloneNode(true);
      copy.querySelectorAll('input, select, textarea, option').forEach((n) => n.remove());
      const t = tidy(textOf(copy));
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return tidy(aria);
    // Walk up a few levels looking for a label-like element in the same field container.
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const cand = node.querySelector('label, legend, [class*="label" i], [class*="question" i], h3, h4');
      if (cand && !cand.contains(el)) { const t = tidy(textOf(cand)); if (t && t.length < 400) return t; }
    }
    return tidy(el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '');
  };

  // The question of a radio or checkbox group. The labels of the group's own options are never
  // the question, even when they look like one (Ashby styles both the same way).
  const groupLabel = (el, peers, optionTexts) => {
    const ownsOption = (n) =>
      peers.some((p) => n.contains(p) || (p.id && n.getAttribute('for') === p.id)) || optionTexts.has(clean(textOf(n)));
    const firstTitle = (root, selector) => {
      for (const cand of Array.from(root.querySelectorAll(selector))) {
        if (cand.contains(el) || cand.querySelector('input') || ownsOption(cand)) continue;
        const t = tidy(textOf(cand));
        if (t && t.length < 400) return t;
      }
      return '';
    };
    const fs = el.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg) { const t = tidy(textOf(lg)); if (t) return t; }
      const t = firstTitle(fs, 'label, [class*="label" i], [class*="question" i], [class*="title" i], h3, h4');
      if (t) return t;
    }
    const group = el.closest('[role="radiogroup"], [role="group"]');
    if (group) {
      const lb = group.getAttribute('aria-labelledby');
      if (lb) { const t = tidy(textOfIds(lb)); if (t) return t; }
      const al = group.getAttribute('aria-label');
      if (al) return tidy(al);
    }
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const t = firstTitle(node, 'legend, [class*="label" i], [class*="question" i], h3, h4, p');
      if (t) return t;
    }
    return tidy(el.name || '');
  };

  const isRequired = (el, label) =>
    el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label || '') || /✱/.test(label || '') || /\(required\)/i.test(label || '');

  const fileHint = (text) => {
    const t = (text || '').toLowerCase();
    if (/cover/.test(t)) return 'cover_letter';
    if (/resume|résumé|\bcv\b/.test(t)) return 'resume';
    return 'other';
  };

  const fields = [];
  const usedKeys = new Set();
  const uniqueKey = (base) => {
    let key = (base || 'field').toString().slice(0, 120);
    let n = 2;
    while (usedKeys.has(key)) key = base + '_' + (n++);
    usedKeys.add(key);
    return key;
  };
  const doneGroups = new Set();

  const all = Array.from(document.querySelectorAll('input, textarea, select'));
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search', 'password'].includes(type)) continue;
    if (el.disabled) continue;
    // Greenhouse puts a hidden required helper input next to each custom dropdown. It isn't a field.
    // Only inputs are skipped. select2 keeps the real <select> at 1px with aria-hidden, and it is the field.
    if (tag === 'input' && type !== 'file' && type !== 'radio' && type !== 'checkbox') {
      if (el.getAttribute('aria-hidden') === 'true') continue;
      if (el.getAttribute('tabindex') === '-1' && window.getComputedStyle(el).opacity === '0') continue;
    }
    if (type !== 'file' && !isVisible(el) && !(type === 'radio' || type === 'checkbox')) continue;

    if (type === 'radio' || type === 'checkbox') {
      const name = el.name || '';
      const peers = name ? all.filter((x) => x.name === name && (x.getAttribute('type') || '').toLowerCase() === type) : [el];
      if (type === 'checkbox' && peers.length <= 1) {
        const rawLabel = labelFor(el);
        fields.push({
          key: uniqueKey(name || el.id || rawLabel), jpId: idFor(el), label: clean(rawLabel), type: 'checkbox',
          required: isRequired(el, rawLabel), options: [], optionIds: [], placeholder: null, maxLength: null, fileHint: null,
          hasValue: el.checked
        });
        continue;
      }
      if (doneGroups.has(type + ':' + name)) continue;
      doneGroups.add(type + ':' + name);
      const options = peers.map((p) => clean(labelFor(p)));
      const rawLabel = groupLabel(el, peers, new Set(options.filter(Boolean)));
      fields.push({
        key: uniqueKey(name || rawLabel), jpId: idFor(el), label: clean(rawLabel), type: type === 'radio' ? 'radio' : 'checkboxes',
        required: peers.some((p) => isRequired(p, rawLabel)), options, optionIds: peers.map(idFor),
        placeholder: null, maxLength: null, fileHint: null, hasValue: peers.some((p) => p.checked)
      });
      continue;
    }

    const rawLabel = labelFor(el);
    let fieldType = 'text';
    let options = [];
    if (tag === 'select') {
      fieldType = el.multiple ? 'multiselect' : 'select';
      options = Array.from(el.options).filter((o) => o.value !== '' && !/^(select|choose|please select|--)/i.test(o.text.trim())).map((o) => clean(o.text));
    } else if (tag === 'textarea') {
      fieldType = 'textarea';
    } else if (type === 'file') {
      fieldType = 'file';
    } else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') {
      fieldType = 'combobox';
    } else if (['email', 'tel', 'url', 'number', 'date'].includes(type)) {
      fieldType = type;
    }
    const max = el.maxLength && el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength : null;
    fields.push({
      key: uniqueKey(el.name || el.id || rawLabel),
      jpId: idFor(el),
      label: clean(rawLabel),
      type: fieldType,
      required: isRequired(el, rawLabel),
      options,
      optionIds: [],
      placeholder: el.getAttribute('placeholder'),
      maxLength: max,
      fileHint: fieldType === 'file' ? fileHint(rawLabel + ' ' + (el.name || '') + ' ' + (el.id || '')) : null,
      hasValue: fieldType === 'file' ? Boolean(el.files && el.files.length) : (el.value || '').trim() !== ''
    });
  }
  document.documentElement.dataset.jpCounter = String(counter);
  return fields;
})()`
