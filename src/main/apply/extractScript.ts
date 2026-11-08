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
  /**
   * The form's own instruction for the question: text after the required marker, a placeholder that reads as an
   * instruction, or the text aria-describedby points to. Short, or null when the form gives none.
   */
  hint?: string | null
}

// A plain text input followed by a suggestion container (Lever's location box). The container
// is a sibling with a dropdown-like class and holds no inputs or buttons of its own.
const SUGGESTION_BOX = String.raw`const suggestionBox = (el) => {
  if (el.tagName !== 'INPUT' || el.getAttribute('role') || !el.parentElement) return null;
  if ((el.getAttribute('type') || 'text').toLowerCase() !== 'text') return null;
  for (const n of Array.from(el.parentElement.children)) {
    if (n === el || n.contains(el)) continue;
    if (/dropdown|suggest|autocomplete|typeahead/i.test(n.getAttribute('class') || '') && !n.querySelector('input, select, textarea, button')) return n;
  }
  return null;
};`

/**
 * Page script for a text input, found by its jp id. Tags the visible suggestion items next to it
 * with data-jp-sug="<jp id>" and returns that id, or '' when the input has no suggestion
 * container. Pages empty and refill the list, so this runs again on every look.
 */
export const tagSuggestionsScript = (jpId: string): string => String.raw`(() => {
  ${SUGGESTION_BOX}
  const id = ${JSON.stringify(jpId)};
  const el = document.querySelector('[data-jp-id="' + id + '"]');
  document.querySelectorAll('[data-jp-sug="' + id + '"]').forEach((n) => n.removeAttribute('data-jp-sug'));
  const box = el ? suggestionBox(el) : null;
  if (!box) return '';
  const skip = /no-?results?|loading|empty|error|spinner|message/i;
  const listy = /result|list|option|suggest|menu|items/i;
  const lists = [box, ...Array.from(box.querySelectorAll('*'))].filter((n) => {
    const c = n.getAttribute('class') || '';
    return n.children.length > 0 && listy.test(c) && !skip.test(c);
  });
  for (const list of lists) {
    const items = Array.from(list.children).filter((n) => (n.textContent || '').trim() !== '' && !skip.test(n.getAttribute('class') || ''));
    if (!items.length) continue;
    items.forEach((n) => n.setAttribute('data-jp-sug', id));
    break;
  }
  return id;
})()`

/**
 * Page script for a dropdown's input after a pick. Returns the input's value, the text its control
 * displays (react-select keeps the choice in a sibling element, not in the input), and whether a
 * hidden input beside it (Lever's selected location) is filled. The display is read from the widest
 * wrapper around the input that holds no label and no other control.
 */
export const readPickedScript = (jpId: string): string => String.raw`(() => {
  const el = document.querySelector('[data-jp-id="' + ${JSON.stringify(jpId)} + '"]');
  if (!el) return null;
  const hidden = Array.from(el.parentElement ? el.parentElement.querySelectorAll('input[type="hidden"]') : []);
  const otherControl = (n) => Array.from(n.querySelectorAll('input, select, textarea')).some((x) =>
    x !== el && x.type !== 'hidden' && x.getAttribute('aria-hidden') !== 'true' && x.getAttribute('tabindex') !== '-1');
  let wrap = el.parentElement;
  for (let depth = 0; wrap && wrap.parentElement && depth < 3; depth++) {
    const up = wrap.parentElement;
    if (up === document.body || up.querySelector('label, legend') || otherControl(up)) break;
    wrap = up;
  }
  let display = '';
  if (wrap) {
    const copy = wrap.cloneNode(true);
    copy.querySelectorAll('label, legend, [role="listbox"], [role="option"], [aria-live], script, style, input, select, textarea, svg').forEach((n) => n.remove());
    display = (copy.textContent || '').replace(/\s+/g, ' ').trim();
  }
  return { value: el.value || '', display, hiddenFilled: hidden.length === 0 || hidden.some((h) => (h.value || '') !== '') };
})()`

export const EXTRACT_FIELDS_SCRIPT = String.raw`(() => {
  ${SUGGESTION_BOX}
  // Labels keep a trailing "*" until isRequired has seen it. clean() drops it for display. Lever
  // marks required questions with "✱" and puts helper text after it, so the label ends there.
  const tidy = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const clean = (s) => tidy(tidy(s).split('✱')[0]).replace(/(?<=\S)\s*\*\s+\S.*$/, '').replace(/\s*\*\s*$/, '').trim();
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

  const inRequiredGroup = (el) => {
    const g = el.closest('[role="group"], [role="radiogroup"]');
    return Boolean(g) && g.getAttribute('aria-required') === 'true';
  };
  const isRequired = (el, label) =>
    el.required || el.getAttribute('aria-required') === 'true' || inRequiredGroup(el) || /\*\s*$/.test(label || '') || /✱/.test(label || '') || /(?<=\S)\s*\*\s+\S/.test(label || '') || /\(required\)/i.test(label || '');

  // The form's own instruction for a question. It comes from the text after the required marker, a placeholder that
  // reads as an instruction, and the text aria-describedby points to. Kept short, on one line.
  const HINT_MAX = 300;
  const afterMarker = (raw) => {
    const t = tidy(raw);
    const star = t.indexOf('✱');
    if (star >= 0) return tidy(t.slice(star + 1));
    const m = t.match(/(?<=\S)\s*\*\s+(\S.*)$/);
    return m ? tidy(m[1]) : '';
  };
  const LIMIT_WORDS = /\b(words?|characters?|chars?|sentences?|limit|max(?:imum)?|min(?:imum)?|at least|at most|up to|no more than|fewer than|less than)\b/i;
  const ASK_WORDS = /\b(include|describe|explain|provide|share|list|tell us|briefly|link|url|in english|in \d+)\b/i;
  const placeholderHint = (el) => {
    const p = tidy(el.getAttribute('placeholder') || '');
    if (p.length < 8) return '';
    if (/^(e\.?g\.?|ex\.?|example|for example)\b/i.test(p) || /^(https?:\/\/|www\.)\S*$/i.test(p) || /^\S+@\S+$/.test(p)) return '';
    return LIMIT_WORDS.test(p) || ASK_WORDS.test(p) ? p : '';
  };
  const describedText = (el) => {
    if (!el) return '';
    const out = [];
    for (const id of (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)) {
      const n = document.getElementById(id);
      if (!n) continue;
      // An error message is not an instruction.
      if (n.getAttribute('role') === 'alert' || n.getAttribute('aria-live') === 'assertive' || /error|invalid/i.test(n.getAttribute('class') || '')) continue;
      const t = tidy(textOf(n));
      if (t && !/^(this field is )?(required|invalid)\b/i.test(t)) out.push(t);
    }
    return out.join(' ');
  };
  // A dropdown's own prompt ("Select...", "Choose...", "--") is not an instruction. Greenhouse's react-select points
  // aria-describedby at it.
  const PLACEHOLDER_TEXT = /^(?:[-–—_.…\s]*|-+\s*(?:please\s+)?(?:select|choose|pick)?[^-]{0,20}-+|(?:please\s+)?(?:select|choose|pick)(?:\s+(?:an?\s+)?(?:one|option|answer|value|item))?\s*(?:\.{2,}|…)?|(?:start\s+typing|type\s+to\s+search|search)\s*(?:\.{2,}|…)?)$/i;
  // Text that only lists the field's options ("Yes, No") adds nothing the options do not already say.
  const listsOptions = (low, options) => {
    const opts = Array.from(new Set((options || []).map((o) => String(o).toLowerCase().trim()).filter(Boolean))).sort((a, b) => b.length - a.length);
    if (opts.length < 2) return false;
    let rest = low;
    let hits = 0;
    for (const o of opts) {
      if (rest.includes(o)) { hits++; rest = rest.split(o).join(' '); }
    }
    return hits >= 2 && /^(?:[\s,;:/|·•–—-]|\bor\b|\band\b)*$/.test(rest);
  };
  // Joins the sources, leaving out one that repeats another, the label itself, a dropdown prompt or the option list.
  const hintFrom = (rawLabel, sources, options) => {
    const label = clean(rawLabel).toLowerCase();
    const parts = [];
    for (const raw of [afterMarker(rawLabel), ...sources]) {
      const t = tidy(raw);
      const low = t.toLowerCase();
      if (!t || low === label || PLACEHOLDER_TEXT.test(t) || listsOptions(low, options) || parts.some((x) => x.toLowerCase().includes(low))) continue;
      parts.push(t);
    }
    const joined = tidy(parts.join(' '));
    if (!joined) return null;
    return joined.length > HINT_MAX ? joined.slice(0, HINT_MAX - 1).trimEnd() + '…' : joined;
  };

  // A label naming both a resume and a cover letter ("Resume or cover letter") means the resume.
  const fileHint = (text) => {
    const t = (text || '').toLowerCase();
    const resume = /resume|résumé|\bcv\b|curriculum|lebenslauf|(?<!additional |other |extra |optional )attachments?/.test(t);
    if (/cover/.test(t) && !resume) return 'cover_letter';
    return resume ? 'resume' : 'other';
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

  // Ashby's yes/no question is two toggle buttons plus a hidden checkbox that nothing reads.
  const YESNO = '.ashby-application-form-input-yesno';
  const cut = (x) => typeof x.checkVisibility === 'function' && !x.checkVisibility();
  // A radio or checkbox that a display:none ancestor hides. Custom inputs that are styled away
  // themselves (opacity 0, or display:none on the input) still belong to a visible label.
  const hiddenByAncestor = (x) => Boolean(x.parentElement) && cut(x.parentElement);

  const all = Array.from(document.querySelectorAll('input, textarea, select, ' + YESNO));
  for (const el of all) {
    if (el.matches(YESNO)) {
      const buttons = Array.from(el.querySelectorAll('button'));
      if (buttons.length < 2 || !isVisible(el) || cut(el)) continue;
      const entry = el.closest('.ashby-application-form-field-entry') || el.parentElement;
      const box = el.querySelector('input[type="checkbox"]');
      const lab = (box && box.id && document.querySelector('label[for="' + CSS.escape(box.id) + '"]')) || (entry && entry.querySelector('label, [class*="question-title"]'));
      const rawLabel = lab ? tidy(textOf(lab)) : '';
      const options = buttons.map((b) => clean(textOf(b)));
      const needed = Boolean(lab && /_required_/.test(lab.getAttribute('class') || '')) || inRequiredGroup(buttons[0]) ||
        el.getAttribute('aria-required') === 'true' || Boolean(box && box.required) || isRequired(buttons[0], rawLabel);
      fields.push({
        key: uniqueKey((box && (box.name || box.id)) || clean(rawLabel)), jpId: idFor(buttons[0]), label: clean(rawLabel), type: 'radio',
        required: needed, options, optionIds: buttons.map(idFor), placeholder: null, maxLength: null, fileHint: null,
        hasValue: buttons.some((b) => b.getAttribute('aria-pressed') === 'true'),
        hint: hintFrom(rawLabel, [describedText(box)], options)
      });
      continue;
    }
    if (el.closest(YESNO)) continue;
    // Ashby's "Autofill from resume" pane has its own upload. It is not an application question.
    if (el.closest('[class*="ashby-application-form-autofill"]')) continue;
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
      // Lever keeps its demographic surveys in hidden sections. A group nobody can see is not a question.
      if (peers.every(hiddenByAncestor)) continue;
      if (type === 'checkbox' && peers.length <= 1) {
        const rawLabel = labelFor(el);
        fields.push({
          key: uniqueKey(name || el.id || rawLabel), jpId: idFor(el), label: clean(rawLabel), type: 'checkbox',
          required: isRequired(el, rawLabel), options: [], optionIds: [], placeholder: null, maxLength: null, fileHint: null,
          hasValue: el.checked,
          hint: hintFrom(rawLabel, [describedText(el)])
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
        placeholder: null, maxLength: null, fileHint: null, hasValue: peers.some((p) => p.checked),
        hint: hintFrom(rawLabel, [describedText(el.closest('fieldset, [role="radiogroup"], [role="group"]')), describedText(el)], options)
      });
      continue;
    }

    let rawLabel = labelFor(el);
    // Greenhouse puts an upload's label on its group. The input's own label is only "Attach".
    const uploadGroup = type === 'file' ? el.closest('[role="group"][aria-labelledby]') : null;
    if (uploadGroup) { const t = tidy(textOfIds(uploadGroup.getAttribute('aria-labelledby'))); if (t) rawLabel = t; }
    let fieldType = 'text';
    let options = [];
    if (tag === 'select') {
      fieldType = el.multiple ? 'multiselect' : 'select';
      // Only the placeholder goes. It is the first option, with no value or a "Select..." style text.
      const first = el.options[0];
      const placeholder = first && !el.multiple && (first.value === '' || /^(\.\.\.|--|—|please select|select( an? | one|\.|…|$)|choose( an? | one|\.|…|$))/i.test(first.text.trim())) ? first : null;
      options = Array.from(el.options).filter((o) => o !== placeholder && o.text.trim() !== '').map((o) => clean(o.text));
    } else if (tag === 'textarea') {
      fieldType = 'textarea';
    } else if (type === 'file') {
      fieldType = 'file';
    } else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') {
      fieldType = 'combobox';
    } else if (suggestionBox(el)) {
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
      hasValue: fieldType === 'file' ? Boolean(el.files && el.files.length) : (el.value || '').trim() !== '',
      hint: hintFrom(rawLabel, [fieldType === 'file' || tag === 'select' ? '' : placeholderHint(el), describedText(el)], options)
    });
  }
  // A lone upload that is not clearly a cover letter is the resume.
  const uploads = fields.filter((f) => f.type === 'file');
  if (uploads.length === 1 && uploads[0].fileHint === 'other') uploads[0].fileHint = 'resume';
  document.documentElement.dataset.jpCounter = String(counter);
  return fields;
})()`
