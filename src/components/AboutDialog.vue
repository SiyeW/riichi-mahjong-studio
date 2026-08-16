<template>
  <div class="settings-modal-backdrop">
    <section class="settings-modal about-modal">
      <div class="settings-modal-header">
        <h2>{{ t('about.title') }}</h2>
        <div class="settings-modal-actions">
          <button class="settings-btn-secondary" @click="emit('close')">{{ t('common.close') }}</button>
        </div>
      </div>
      <div class="about-brand">
        <div>
          <strong>Riichi Mahjong Studio</strong>
          <span>{{ t('app.subtitle') }}</span>
        </div>
      </div>
      <div class="about-grid">
        <div class="about-item">
          <span class="about-label">{{ t('about.version') }}</span>
          <span class="about-value">{{ appVersion }}</span>
        </div>
        <div class="about-item">
          <span class="about-label">{{ t('about.license') }}</span>
          <span class="about-value">Apache License 2.0</span>
          <div class="about-document-actions">
            <button class="settings-btn-secondary" @click="openLegalDocument('license')">{{ t('about.viewLicense') }}</button>
            <button class="settings-btn-secondary" @click="openLegalDocument('thirdPartyNotices')">{{ t('about.viewNotices') }}</button>
          </div>
          <small class="about-legal-note">{{ t('about.legalNote') }}</small>
        </div>
        <div class="about-item">
          <span class="about-label">{{ t('about.thirdParty') }}</span>
          <div class="about-link-list">
            <div class="about-link-row">
              <a href="https://github.com/killerducky/killer_mortal_gui" @click.prevent="openExternalLink('https://github.com/killerducky/killer_mortal_gui')">killerducky/killer_mortal_gui</a>
              <span class="about-link-license">MIT</span>
            </div>
            <div class="about-link-row">
              <a href="https://github.com/FluffyStuff/riichi-mahjong-tiles" @click.prevent="openExternalLink('https://github.com/FluffyStuff/riichi-mahjong-tiles')">FluffyStuff/riichi-mahjong-tiles</a>
              <span class="about-link-license">CC0 1.0</span>
            </div>
            <div class="about-link-row">
              <a href="https://github.com/MahjongRepository/mahjong" @click.prevent="openExternalLink('https://github.com/MahjongRepository/mahjong')">MahjongRepository/mahjong</a>
              <span class="about-link-license">MIT</span>
            </div>
          </div>
        </div>
        <div class="about-item">
          <span class="about-label">{{ t('about.maintainer') }}</span>
          <div class="about-link-list">
            <div class="about-link-row">
              <a href="https://github.com/SiyeW" @click.prevent="openExternalLink('https://github.com/SiyeW')">SiyeW</a>
              <span class="about-link-license">GitHub</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import packageJson from '../../package.json'
import { useI18n } from '../i18n'

const { t } = useI18n()

const emit = defineEmits<{ close: [] }>()
const appVersion = String(packageJson.version || '')

function openExternalLink(url: string) {
  void window.trainerAPI?.openExternal(url).catch((error) => {
    console.error('Failed to open external link:', error)
  })
}

function openLegalDocument(documentId: 'license' | 'thirdPartyNotices') {
  void window.trainerAPI?.openAppLegalDocument(documentId).catch((error) => {
    console.error('Failed to open application legal document:', error)
  })
}
</script>

<style scoped>
.about-modal {
  width: min(calc(43.75rem * var(--ui-scale)), 92vw);
}

.about-brand {
  display: flex;
  align-items: center;
  gap: calc(0.8rem * var(--chrome-scale));
  margin-bottom: calc(0.9rem * var(--chrome-scale));
}

.about-brand > div {
  display: grid;
  gap: calc(0.12rem * var(--chrome-scale));
}

.about-brand span {
  color: var(--text-dim);
  font-size: var(--ui-text-caption);
  letter-spacing: 0.12em;
}

.about-brand strong {
  color: var(--text-main);
  font-size: var(--ui-text-title);
  line-height: 1.15;
}

.about-grid {
  display: grid;
  gap: calc(0.75rem * var(--chrome-scale));
}

.about-item {
  display: grid;
  gap: calc(0.22rem * var(--chrome-scale));
}

.about-label {
  font-size: var(--ui-text-body);
  color: var(--text-dim);
}

.about-value {
  min-height: calc(1.1rem * var(--chrome-scale));
  font-size: var(--ui-text-heading);
  color: var(--text-main);
}

.about-link-list {
  display: grid;
  gap: calc(0.22rem * var(--chrome-scale));
}

.about-link-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: calc(0.8rem * var(--chrome-scale));
}

.about-link-list a {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: calc(0.8rem * var(--chrome-scale));
  color: rgba(197, 243, 233, 0.95);
  text-decoration: none;
  font-size: var(--ui-text-heading);
}

.about-link-list a:hover {
  text-decoration: underline;
}

.about-link-license {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-size: var(--ui-text-heading);
}

.about-document-actions {
  display: flex;
  flex-wrap: wrap;
  gap: calc(0.35rem * var(--chrome-scale));
}

.about-legal-note {
  color: var(--text-muted);
  font-size: var(--ui-text-caption);
  line-height: 1.45;
}
</style>
