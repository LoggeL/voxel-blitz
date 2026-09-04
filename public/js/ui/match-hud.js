import { GUN_GAME_WEAPON_ORDER } from '../../../shared/modes.js';
import {
  MODE_LABELS,
  MAP_LABELS,
  clamp01,
  el,
  formatClock,
} from './hud-support.js';
import { MatchResultOverlay } from './match-result-overlay.js';
import { PlayerStatusStrip } from './player-status-strip.js';

const EMPTY_READ_MODEL = Object.freeze({ dead: false });
const noop = () => {};

function clearBag(bag) {
  for (const key of Object.keys(bag)) delete bag[key];
}

/** Owns the authoritative match header, objective, and economy presentation. */
export class MatchHud {
  constructor({
    onBuyMenuState = noop,
    onPlayers = noop,
    readModel = EMPTY_READ_MODEL,
    resultOverlay = null,
  } = {}) {
    this.onBuyMenuState = onBuyMenuState;
    this.onPlayers = onPlayers;
    this.readModel = readModel;
    this.result = resultOverlay || new MatchResultOverlay();
    this.playerStatus = new PlayerStatusStrip();

    this.dom = {};
    this._latestMatch = null;
    this._latestSelfRow = null;
    this._latestPlayers = [];
  }

  build(hud) {
    this._removeDom();
    clearBag(this.dom);
    const m = this.dom;

    const matchHeader = el('div', 'vb-match-header', hud, 'match-header');
    m.header = matchHeader;

    const alphaBlock = el('div', 'vb-match-team vb-team-alpha', matchHeader, 'match-team-alpha');
    const alphaLeft = el('div', 'vb-team-details', alphaBlock);
    const alphaName = el('div', 'vb-team-name', alphaLeft);
    alphaName.textContent = 'ALPHA';
    const alphaRole = el('div', 'vb-team-role', alphaLeft, 'match-alpha-role');
    alphaRole.textContent = '';
    const alphaScore = el('div', 'vb-team-score', alphaBlock, 'match-alpha-score');
    alphaScore.textContent = '0';
    m.alphaBlock = alphaBlock;
    m.alphaRole = alphaRole;
    m.alphaScore = alphaScore;

    const centerBlock = el('div', 'vb-match-center', matchHeader, 'match-center');
    const metaBar = el('div', 'vb-match-meta-bar', centerBlock);
    const modeBadge = el('span', 'vb-match-mode-chip', metaBar, 'match-mode-chip');
    modeBadge.textContent = 'SEARCH & DESTROY';
    const mapBadge = el('span', 'vb-match-map-chip', metaBar, 'match-map-chip');
    mapBadge.textContent = 'CITADEL';

    const clockBox = el('div', 'vb-match-clock-box', centerBlock);
    const clock = el('div', 'vb-match-clock', clockBox, 'match-clock');
    clock.textContent = '0:00';
    const phaseLabel = el('div', 'vb-match-phase-label', clockBox, 'match-phase-label');
    phaseLabel.textContent = 'PREP PHASE';

    const bombBanner = el('div', 'vb-match-bomb-banner', centerBlock, 'match-bomb-banner');
    bombBanner.style.display = 'none';

    m.modeBadge = modeBadge;
    m.mapBadge = mapBadge;
    m.clock = clock;
    m.phaseLabel = phaseLabel;
    m.bombBanner = bombBanner;

    const bravoBlock = el('div', 'vb-match-team vb-team-bravo', matchHeader, 'match-team-bravo');
    const bravoScore = el('div', 'vb-team-score', bravoBlock, 'match-bravo-score');
    bravoScore.textContent = '0';
    const bravoRight = el('div', 'vb-team-details', bravoBlock);
    const bravoName = el('div', 'vb-team-name', bravoRight);
    bravoName.textContent = 'BRAVO';
    const bravoRole = el('div', 'vb-team-role', bravoRight, 'match-bravo-role');
    bravoRole.textContent = '';
    m.bravoBlock = bravoBlock;
    m.bravoRole = bravoRole;
    m.bravoScore = bravoScore;

    m.playerStatus = this.playerStatus.build(hud);

    const interactBar = el('div', 'vb-interaction-bar', hud, 'interaction-bar');
    interactBar.style.display = 'none';
    const interactLabel = el('div', 'vb-interaction-label', interactBar, 'interaction-label');
    interactLabel.textContent = 'PLANTING BOMB...';
    const interactTrack = el('div', 'vb-interaction-track', interactBar);
    const interactFill = el('div', 'vb-interaction-fill', interactTrack, 'interaction-fill');
    const interactHint = el('div', 'vb-interaction-hint', interactBar);
    interactHint.textContent = 'HOLD [E]';

    m.interactBar = interactBar;
    m.interactLabel = interactLabel;
    m.interactFill = interactFill;

    const econCluster = el('div', 'vb-econ-cluster', hud, 'econ-cluster');
    const creditsBox = el('div', 'vb-hud-credits', econCluster, 'hud-credits');
    el('span', 'vb-hud-credits-label', creditsBox).textContent = 'CREDITS';
    const creditsVal = el('span', 'vb-hud-credits-val', creditsBox, 'hud-credits-val');
    creditsVal.textContent = '$ 800';

    const carrierBadge = el('div', 'vb-carrier-badge', econCluster, 'hud-carrier-badge');
    carrierBadge.textContent = 'BOMB CARRIER';
    carrierBadge.style.display = 'none';

    const buyPrompt = el('div', 'vb-buy-prompt', econCluster, 'hud-buy-prompt');
    buyPrompt.textContent = '[B] ARMORY OPEN';
    buyPrompt.style.display = 'none';

    m.creditsBox = creditsBox;
    m.creditsVal = creditsVal;
    m.carrierBadge = carrierBadge;
    m.buyPrompt = buyPrompt;

    this.result.build(hud);

    return m;
  }

  setMatchState(match, selfRow, players, serverNow) {
    this._latestMatch = match || null;
    this._latestSelfRow = selfRow || null;
    this._latestPlayers = Array.isArray(players) ? players : [];

    const m = this.dom;
    if (!m.header) return;

    const curMode = match?.mode || 'fun';
    const curMap = match?.map || 'foundry';
    const phase = match?.phase || 'live';
    const isTeamMode = curMode === 'tdm' || curMode === 'snd';
    this.playerStatus.update(this._latestPlayers, curMode, selfRow?.id);

    if (m.modeBadge) {
      m.modeBadge.textContent = MODE_LABELS[curMode] || curMode.toUpperCase();
    }
    if (m.mapBadge) {
      m.mapBadge.textContent = MAP_LABELS[curMap] || curMap.toUpperCase();
    }

    const sNow = Number.isFinite(serverNow) && serverNow > 0 ? serverNow : Date.now();
    this.result.update(match, selfRow, this._latestPlayers, sNow);
    let clockText = '--:--';
    let isUrgentBomb = false;

    if (curMode === 'snd' && match?.bomb?.state === 'planted' && Number.isFinite(match.bomb.explodeAt)) {
      const fuseRemSec = Math.max(0, (match.bomb.explodeAt - sNow) / 1000);
      clockText = `${fuseRemSec.toFixed(1)}s`;
      isUrgentBomb = true;
    } else if (Number.isFinite(match?.phaseEndsAt)) {
      const remSec = Math.max(0, (match.phaseEndsAt - sNow) / 1000);
      clockText = formatClock(remSec);
    }

    if (m.clock) {
      m.clock.textContent = clockText;
      m.clock.classList.toggle('vb-clock-urgent', isUrgentBomb);
    }

    if (m.phaseLabel) {
      if (curMode === 'snd') {
        const roundNum = match?.round || 1;
        if (phase === 'prep') {
          m.phaseLabel.textContent = `ROUND ${roundNum} / 13 · PREP PHASE`;
        } else if (phase === 'post') {
          const rw = match?.roundWinner ? match.roundWinner.toUpperCase() : 'ROUND';
          m.phaseLabel.textContent = `ROUND ${roundNum} OVER · ${rw} WON`;
        } else {
          m.phaseLabel.textContent = `ROUND ${roundNum} / 13 · OBJECTIVE LIVE`;
        }
      } else if (curMode === 'tdm') {
        m.phaseLabel.textContent = phase === 'post' ? 'MATCH CONCLUDED' : 'TEAM DEATHMATCH · FIRST TO 40';
      } else if (curMode === 'gungame') {
        if (phase === 'post') {
          m.phaseLabel.textContent = match?.winner
            ? `${this._nameFor(match.winner)} WON GUN GAME`
            : 'GUN GAME CONCLUDED';
        } else {
          const lastLevel = GUN_GAME_WEAPON_ORDER.length - 1;
          const level = Math.max(0, Math.min(lastLevel, selfRow?.score | 0));
          m.phaseLabel.textContent = `GUN GAME · WEAPON ${level + 1} / ${GUN_GAME_WEAPON_ORDER.length}`;
        }
      } else if (curMode === 'training') {
        m.phaseLabel.textContent = 'TRAINING · RANGE & KILLHOUSE';
      } else {
        m.phaseLabel.textContent = 'INSTANT SKIRMISH · FREE FOR ALL';
      }
    }

    if (isTeamMode) {
      if (m.alphaBlock) m.alphaBlock.style.display = 'flex';
      if (m.bravoBlock) m.bravoBlock.style.display = 'flex';

      const alphaSc = match?.scores?.alpha ?? 0;
      const bravoSc = match?.scores?.bravo ?? 0;
      if (m.alphaScore) m.alphaScore.textContent = String(alphaSc);
      if (m.bravoScore) m.bravoScore.textContent = String(bravoSc);

      if (curMode === 'snd') {
        const alphaIsAttacker = match?.attackers === 'alpha';
        if (m.alphaRole) {
          m.alphaRole.textContent = alphaIsAttacker ? 'ATTACK' : 'DEFEND';
          m.alphaRole.className = `vb-team-role ${alphaIsAttacker ? 'vb-role-attack' : 'vb-role-defend'}`;
        }
        if (m.bravoRole) {
          m.bravoRole.textContent = alphaIsAttacker ? 'DEFEND' : 'ATTACK';
          m.bravoRole.className = `vb-team-role ${alphaIsAttacker ? 'vb-role-defend' : 'vb-role-attack'}`;
        }
      } else {
        if (m.alphaRole) m.alphaRole.textContent = '';
        if (m.bravoRole) m.bravoRole.textContent = '';
      }
    } else {
      if (m.alphaBlock) m.alphaBlock.style.display = 'none';
      if (m.bravoBlock) m.bravoBlock.style.display = 'none';
    }

    if (m.bombBanner) {
      if (curMode === 'snd' && match?.bomb) {
        const b = match.bomb;
        m.bombBanner.style.display = 'block';
        m.bombBanner.className = `vb-match-bomb-banner state-${b.state || 'none'}`;

        if (b.state === 'carried') {
          m.bombBanner.textContent = 'BOMB: IN POSSESSION';
        } else if (b.state === 'dropped') {
          m.bombBanner.textContent = 'BOMB: DROPPED ON GROUND';
        } else if (b.state === 'planted') {
          m.bombBanner.textContent = `BOMB PLANTED AT SITE ${String(b.site || 'A').toUpperCase()}`;
        } else if (b.state === 'defused') {
          m.bombBanner.textContent = 'BOMB: DEFUSED (DEFENDERS WIN)';
        } else if (b.state === 'exploded') {
          m.bombBanner.textContent = 'BOMB: DETONATED (ATTACKERS WIN)';
        } else {
          m.bombBanner.textContent = 'BOMB OBJECTIVE';
        }
      } else {
        m.bombBanner.style.display = 'none';
      }
    }

    if (m.interactBar) {
      const isDead = this.readModel.dead === true || (selfRow && (selfRow.hp <= 0 || selfRow.state === 'dead'));
      const isPhaseValid = curMode === 'snd' && phase === 'live';
      const interaction = selfRow?.interaction;
      const progress = Number(interaction?.progress);
      const hasProgress = Number.isFinite(progress) && progress > 0;

      if (!isDead && isPhaseValid && interaction && hasProgress) {
        m.interactBar.style.display = 'block';
        const kind = String(interaction.kind || '').toLowerCase();
        const type = kind === 'plant' ? 'PLANTING BOMB' : (kind === 'defuse' ? 'DEFUSING BOMB' : 'INTERACTING');
        const site = interaction.site ? ` [SITE ${String(interaction.site).toUpperCase()}]` : '';
        if (m.interactLabel) {
          m.interactLabel.textContent = `${type}${site}...`;
        }
        if (m.interactFill) {
          const pct = clamp01(progress);
          m.interactFill.style.width = `${Math.round(pct * 100)}%`;
        }
      } else {
        m.interactBar.style.display = 'none';
        if (m.interactFill) {
          m.interactFill.style.width = '0%';
        }
      }
    }

    if (selfRow) {
      if (m.creditsBox) {
        m.creditsBox.style.display = curMode === 'snd' ? 'flex' : 'none';
      }
      if (m.creditsVal) {
        m.creditsVal.textContent = `$ ${Number(selfRow.credits || 0).toLocaleString()}`;
      }
      if (m.carrierBadge) {
        m.carrierBadge.style.display = (curMode === 'snd' && selfRow.bomb) ? 'inline-block' : 'none';
      }
      if (m.buyPrompt) {
        const canBuy = curMode === 'snd'
          && phase === 'prep'
          && this.readModel.dead !== true
          && selfRow.hp > 0
          && selfRow.state !== 'dead';
        m.buyPrompt.style.display = canBuy ? 'block' : 'none';
      }

      this.onBuyMenuState({
        phase: match?.phase || 'live',
        credits: selfRow.credits || 0,
        owned: selfRow.owned || [],
      });
    } else {
      if (m.creditsBox) m.creditsBox.style.display = 'none';
      if (m.carrierBadge) m.carrierBadge.style.display = 'none';
      if (m.buyPrompt) m.buyPrompt.style.display = 'none';
      this.onBuyMenuState({
        open: false,
        phase: match?.phase || 'live',
        credits: 0,
        owned: [],
      });
    }

    if (this._latestPlayers) {
      this.onPlayers(this._latestPlayers);
    }
  }

  reset() {
    this.setMatchState(null, null, [], undefined);
  }

  _nameFor(id) {
    const row = this._latestPlayers.find((player) => String(player?.id) === String(id));
    return String(row?.name || id || 'PLAYER').toUpperCase();
  }

  dispose() {
    this.result.dispose();
    this.playerStatus.dispose();
    this._removeDom();
    clearBag(this.dom);
    this._latestMatch = null;
    this._latestSelfRow = null;
    this._latestPlayers = [];
  }

  _removeDom() {
    const { header, interactBar, creditsBox } = this.dom;
    this.playerStatus.dispose();
    if (header) header.remove();
    if (interactBar) interactBar.remove();
    const econCluster = creditsBox && creditsBox.parentNode;
    if (econCluster) econCluster.remove();
  }
}
