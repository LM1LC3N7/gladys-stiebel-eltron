// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and mode names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('STIEBEL ELTRON heat pump', 'Pompe à chaleur STIEBEL ELTRON');

export const FEATURE_NAMES = {
  [FEATURES.MODE]: both('Operating mode', 'Mode de fonctionnement'),
  [FEATURES.MODE_STATE]: both('Operating mode (read)', 'Mode de fonctionnement (lu)'),
  [FEATURES.HEATING_SETPOINT]: both(
    'Heating setpoint (comfort)',
    'Consigne de chauffage (confort)',
  ),
  [FEATURES.HEATING_SETPOINT_ECO]: both('Heating setpoint (eco)', 'Consigne de chauffage (éco)'),
  [FEATURES.DHW_SETPOINT]: both('Hot water setpoint (comfort)', "Consigne d'eau chaude (confort)"),
  [FEATURES.DHW_SETPOINT_ECO]: both('Hot water setpoint (eco)', "Consigne d'eau chaude (éco)"),
  [FEATURES.DHW_TARGET]: both('Hot water target now', "Consigne d'eau chaude en cours"),
  [FEATURES.TEMP_OUTDOOR]: both('Outside temperature', 'Température extérieure'),
  [FEATURES.TEMP_FLOW]: both('Flow temperature', 'Température de départ'),
  [FEATURES.TEMP_RETURN]: both('Return temperature', 'Température de retour'),
  [FEATURES.TEMP_DHW]: both('Hot water temperature', "Température de l'eau chaude"),
  [FEATURES.TEMP_ROOM]: both('Room temperature', 'Température de la pièce'),
  [FEATURES.TEMP_ROOM_FE7]: both('Room temperature (FE7)', 'Température de la pièce (FE7)'),
  [FEATURES.TEMP_ROOM_FEK]: both('Room temperature (FEK)', 'Température de la pièce (FEK)'),
  [FEATURES.HUMIDITY]: both('Room humidity', 'Humidité de la pièce'),
  [FEATURES.COMPRESSOR]: both('Compressor running', 'Compresseur en marche'),
  [FEATURES.BOOSTER]: both('Electric booster running', "Chauffage d'appoint en marche"),
  [FEATURES.FAULT]: both('Fault', 'Défaut'),
  [FEATURES.CONSUMED_HEATING_TODAY]: both(
    'Electricity used, heating (kWh, today)',
    'Électricité consommée, chauffage (kWh, aujourd’hui)',
  ),
  [FEATURES.CONSUMED_HEATING_TOTAL]: both(
    'Electricity used, heating (kWh, total)',
    'Électricité consommée, chauffage (kWh, total)',
  ),
  [FEATURES.CONSUMED_DHW_TODAY]: both(
    'Electricity used, hot water (kWh, today)',
    'Électricité consommée, eau chaude (kWh, aujourd’hui)',
  ),
  [FEATURES.CONSUMED_DHW_TOTAL]: both(
    'Electricity used, hot water (kWh, total)',
    'Électricité consommée, eau chaude (kWh, total)',
  ),
  [FEATURES.PRODUCED_HEATING_TODAY]: both(
    'Heat produced, heating (kWh, today)',
    'Chaleur produite, chauffage (kWh, aujourd’hui)',
  ),
  [FEATURES.PRODUCED_HEATING_TOTAL]: both(
    'Heat produced, heating (kWh, total)',
    'Chaleur produite, chauffage (kWh, total)',
  ),
  [FEATURES.PRODUCED_DHW_TODAY]: both(
    'Heat produced, hot water (kWh, today)',
    'Chaleur produite, eau chaude (kWh, aujourd’hui)',
  ),
  [FEATURES.PRODUCED_DHW_TOTAL]: both(
    'Heat produced, hot water (kWh, total)',
    'Chaleur produite, eau chaude (kWh, total)',
  ),
  [FEATURES.BOOSTER_HEATING_TOTAL]: both(
    'Heat from the booster, heating (kWh, total)',
    "Chaleur de l'appoint, chauffage (kWh, total)",
  ),
  [FEATURES.BOOSTER_DHW_TOTAL]: both(
    'Heat from the booster, hot water (kWh, total)',
    "Chaleur de l'appoint, eau chaude (kWh, total)",
  ),
};

/** The operating modes (src/isg.js MODES). */
export const MODE_NAMES = {
  emergency: both('Emergency operation', 'Mode secours'),
  standby: both('Standby', 'Veille'),
  program: both('Program (automatic)', 'Programme (automatique)'),
  automatic: both('Automatic', 'Automatique'),
  comfort: both('Comfort', 'Confort'),
  day: both('Day (comfort)', 'Jour (confort)'),
  eco: both('Eco', 'Éco'),
  setback: both('Setback (night)', 'Réduit (nuit)'),
  dhw: both('Hot water only', 'Eau chaude seule'),
  manual: both('Manual (service)', 'Manuel (service)'),
};

export const STATE_TEXTS = {
  unknownMode: (code) => both(`Unknown mode (${code})`, `Mode inconnu (${code})`),
  offline: both('ISG unreachable', 'ISG injoignable'),
  otherController: both(
    'Another controller answers at this address',
    'Un autre régulateur répond à cette adresse',
  ),
};

const join = (parts) => both(parts.map((p) => p.en).join(' '), parts.map((p) => p.fr).join(' '));
export { join };

/** The integration status, the button and the logs a user may read. */
export const T = {
  noAddress: both(
    'Enter the IP address of your ISG (Internet Service Gateway), then save.',
    "Saisissez l'adresse IP de votre ISG (Internet Service Gateway), puis enregistrez.",
  ),
  invalid: (typed) =>
    both(
      `Invalid address: ${typed} (an IPv4 address or a host name, with an optional port).`,
      `Adresse invalide : ${typed} (une adresse IPv4 ou un nom d'hôte, avec un port en option).`,
    ),
  connecting: both('Reading the ISG…', "Lecture de l'ISG…"),
  connected: (model, code, notes = []) =>
    join([
      both(
        `Connected: ${model} (controller ${code}).`,
        `Connecté : ${model} (régulateur ${code}).`,
      ),
      ...notes,
    ]),
  unreachable: (address, reason, wait) =>
    both(
      `Could not read the ISG at ${address} (${reason}; next try in ${wait.en}). Check the address and that the Modbus module of the ISG is enabled.`,
      `Lecture de l'ISG ${address} impossible (${reason} ; nouvel essai dans ${wait.fr}). Vérifiez l'adresse et que le module Modbus de l'ISG est activé.`,
    ),
  unsupported: (code, wait) =>
    both(
      `Unknown controller (identification ${code}): only the WPM 3, WPM 3i, WPMsystem and LWZ/LWA controllers are supported (next try in ${wait.en}).`,
      `Régulateur inconnu (identification ${code}) : seuls les régulateurs WPM 3, WPM 3i, WPMsystem et LWZ/LWA sont pris en charge (nouvel essai dans ${wait.fr}).`,
    ),
  notes: {
    failing: (names) =>
      both(
        `Some registers could not be read (${names}).`,
        `Certains registres n'ont pas pu être lus (${names}).`,
      ),
    otherFamily: both(
      'The created device belongs to another controller family: add the new device from the Discovery tab.',
      "L'appareil créé appartient à une autre famille de régulateur : ajoutez le nouvel appareil depuis l'onglet Découverte.",
    ),
  },
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    "Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l'intégration.",
  ),
  badMode: both(
    'Unknown operating mode: not sent.',
    'Mode de fonctionnement inconnu : non envoyé.',
  ),
  badNumber: both(
    'The setpoint must be a number: not sent.',
    'La consigne doit être un nombre : non envoyée.',
  ),
  badStep: (step) =>
    both(
      `The setpoint must be a multiple of ${step} °C: not sent.`,
      `La consigne doit être un multiple de ${String(step).replace('.', ',')} °C : non envoyée.`,
    ),
  outOfRange: (min, max) =>
    both(
      `The setpoint must be between ${min} and ${max} °C: not sent.`,
      `La consigne doit être comprise entre ${min} et ${max} °C : non envoyée.`,
    ),
  dhwCap: (cap) =>
    both(
      `Hot water is capped at ${cap} °C (scalding risk, see "Hot water ceiling" in the configuration): not sent.`,
      `L'eau chaude est plafonnée à ${cap} °C (risque de brûlure, voir « Plafond de l'eau chaude » dans la configuration) : non envoyée.`,
    ),
  unknownDevice: both(
    'This device is not the controller read now (ISG not answering, or another controller): not sent.',
    "Cet appareil n'est pas le régulateur lu actuellement (ISG sans réponse, ou autre régulateur) : non envoyée.",
  ),
  stillRunning: both(
    'Another command to the ISG is still running: not sent.',
    "Une autre commande vers l'ISG est encore en cours : non envoyée.",
  ),
  tooSlow: both(
    'The ISG answered too slowly to send the command in time: not sent.',
    "L'ISG a répondu trop lentement pour envoyer la commande à temps : non envoyée.",
  ),
  unknownState: (reason) =>
    both(
      `The current value could not be read just before (${reason}): command not sent.`,
      `La valeur actuelle n'a pas pu être relue juste avant (${reason}) : commande non envoyée.`,
    ),
  missingValue: both(
    'The ISG did not give the current value of this setting: not sent.',
    "L'ISG n'a pas donné la valeur actuelle de ce réglage : non envoyée.",
  ),
  protectedMode: (mode) =>
    both(
      `The heat pump is in "${mode.en}" mode, set on the controller: Gladys does not leave it. Not sent.`,
      `La pompe à chaleur est en mode « ${mode.fr} », réglé sur le régulateur : Gladys n'en sort pas. Non envoyée.`,
    ),
  notSent: (reason) =>
    both(
      `The ISG could not be reached (${reason}): command not sent.`,
      `L'ISG n'a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(`The ISG refused the command (${reason}).`, `L'ISG a refusé la commande (${reason}).`),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the value in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez la valeur dans quelques secondes.`,
    ),
};
