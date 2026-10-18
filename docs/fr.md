# STIEBEL ELTRON pour Gladys

Affiche votre pompe à chaleur **STIEBEL ELTRON** dans Gladys par l'**ISG**
(Internet Service Gateway, « ISG web ») et son interface **Modbus TCP** :
sans cloud, sans compte, directement sur votre réseau.

> **Module jamais testé avec une vraie ISG.**
> Sans lien avec STIEBEL ELTRON. Il lit les registres Modbus de l'ISG comme
> la bibliothèque pystiebeleltron (utilisée par Home Assistant).

> **Sécurité : Modbus n'a ni mot de passe ni chiffrement.** Toute machine de
> votre réseau peut lire l'ISG et changer les réglages de la pompe à
> chaleur. Gardez l'ISG sur un **réseau de confiance** (jamais exposée sur
> Internet, idéalement sur un réseau séparé pour les objets connectés).

## Régulateurs pris en charge

L'intégration lit l'identification du régulateur et choisit ses registres :

- **WPM** : WPM 3, WPM 3i, WPMsystem (pompes WPL, WPF, WPE…) ;
- **LWZ / LWA** : centrales double flux LWZ 304/404/504, LWZ x04 SOL,
  LWZ R290.

Un autre régulateur est nommé dans l'écran de configuration (« Régulateur
inconnu ») et relu toutes les 30 minutes.

## Ce que vous obtenez

Un appareil « Pompe à chaleur STIEBEL ELTRON ». Chaque fonctionnalité
n'apparaît que si l'ISG en donne la valeur :

| Fonctionnalité                          | Contenu                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| Mode de fonctionnement                  | Liste (commandes autorisées seulement), voir plus bas                        |
| Mode de fonctionnement (lu)             | Texte : le mode réel, y compris secours et manuel                            |
| Consigne de chauffage (confort)         | Thermostat, circuit 1, en °C (commande)                                      |
| Consigne de chauffage (éco)             | En °C, lecture seule (WPM : éco ; LWZ : nuit)                                |
| Consigne d'eau chaude (confort)         | Chauffe-eau, en °C (commande, plafonnée)                                     |
| Consigne d'eau chaude (éco)             | En °C, lecture seule (WPM : éco ; LWZ : nuit)                                |
| Consigne d'eau chaude en cours          | En °C, la consigne que le régulateur applique maintenant                     |
| Températures                            | Extérieure, départ, retour, eau chaude, pièce (FE7, FEK, FET ou LWZ), en °C  |
| Humidité de la pièce                    | En % (commande à distance FEK, LWZ)                                          |
| Compresseur en marche                   | 0 ou 1                                                                       |
| Chauffage d'appoint en marche           | 0 ou 1 (résistance électrique, « NHZ »)                                      |
| Défaut                                  | 0 ou 1                                                                       |
| Électricité consommée, chaleur produite | En kWh, aujourd'hui et total, chauffage et eau chaude ; chaleur de l'appoint |

Les températures d'eau, la température extérieure et les consignes sont des
« sondes » : elles ne comptent pas comme température de la pièce dans
Gladys. Lecture toutes les 30 secondes par défaut (de 10 s à 10 min,
réglable).

### Énergie : de simples valeurs, pas un compteur facturé

L'ISG donne, pour le chauffage et l'eau chaude, un compteur **du jour** et
un **total**. D'après la documentation, le total n'inclut pas le jour et se
met à jour vers minuit ; rien ne garantit qu'il ne fasse jamais un saut ou
un retour en arrière. Gladys compterait chaque hausse d'un index comme une
consommation facturée : ces valeurs sont donc publiées comme de **simples
capteurs** (l'unité est dans leur nom), jamais comme un index d'énergie.
Elles n'apparaissent pas dans le suivi de consommation de Gladys.

## Installation

1. Faites activer le **module Modbus** de votre ISG (le support STIEBEL
   ELTRON le fait, souvent gratuitement).
2. Donnez à l'ISG une **adresse IP fixe** dans votre box internet ou
   routeur.
3. Installez l'intégration depuis le store de Gladys.
4. Dans sa configuration, saisissez l'**adresse IP de l'ISG** (port 502 par
   défaut ; ajoutez `:port` s'il est différent).
5. Enregistrez, puis ajoutez la pompe à chaleur depuis l'onglet
   **Découverte**.

Le bouton **Tester la connexion** lit l'ISG une fois (au plus toutes les
10 secondes).

## Commandes (désactivées par défaut)

Tant que l'option **Autoriser les commandes** est désactivée, toute
commande est refusée. Activée, Gladys peut changer :

- le **mode de fonctionnement** : WPM : programme (automatique), confort,
  éco, eau chaude seule, veille ; LWZ : automatique, jour, réduit (nuit),
  eau chaude seule, veille ;
- la **consigne de chauffage (confort)** du circuit 1 : de 5 à 30 °C (WPM)
  ou de 10 à 30 °C (LWZ), au dixième de degré ;
- la **consigne d'eau chaude (confort)** : en degrés entiers, de 10 °C
  jusqu'au **plafond**.

### Plafond de l'eau chaude : 55 °C par défaut

Une eau à 60 °C brûle en quelques secondes. Gladys ne règle donc **jamais
l'eau chaude au-dessus de 55 °C** par défaut. Le réglage **Plafond de l'eau
chaude** le change de 40 à 60 °C ; il n'est **jamais possible de dépasser
60 °C**, quoi qu'on saisisse (même si certaines LWZ acceptent 65 °C). Une
consigne au-dessus du plafond est refusée sans être envoyée, et le plafond
est revérifié juste avant l'envoi (un plafond abaissé pendant une commande
l'arrête). La consigne éco et le programme anti-légionelles du régulateur
ne sont jamais modifiés.

### Ce que Gladys ne fait jamais

- Choisir le **mode secours** (réglé par l'installateur quand le
  compresseur est en panne) ou le **mode manuel** des LWZ (mode de service).
- **Quitter** l'un de ces modes, ou un mode inconnu : la commande est
  refusée, le régulateur garde la main.
- Proposer un interrupteur : le mode est une **liste**, les consignes sont
  des thermostats ; un « éteins tout » (Gladys, Google Home, Alexa,
  HomeKit) ne touche pas la pompe à chaleur. Une scène peut changer le mode
  ou une consigne, seulement par une action explicite et si les commandes
  sont autorisées. Attention : le chat IA de Gladys (MCP) peut créer et
  lancer une telle scène.

### Comment une commande part

Avant chaque commande, l'intégration **relit les réglages** de la pompe à
chaleur et décide sur cette lecture seule ; aucune autre requête ne passe
entre cette relecture et l'écriture, et l'option (et le plafond) est
revérifiée juste avant l'envoi. Une valeur déjà en place n'est pas
renvoyée. Une commande qui ne peut pas partir dans les 3,5 secondes est
refusée sans être envoyée ; Gladys reçoit la réponse dans ses 5 secondes.
L'ISG confirme une écriture en la renvoyant à l'identique ; sans cette
confirmation (silence, connexion coupée, réponse différente), Gladys
affiche « Commande envoyée, sans confirmation » : vérifiez la valeur,
relue 5 puis 20 secondes plus tard (l'ISG met quelques secondes à
l'afficher). Une commande à la fois.

## Erreurs et limites

- **ISG injoignable** : « Mode de fonctionnement (lu) » affiche « ISG
  injoignable », l'appareil passe en injoignable, les autres valeurs gardent
  leur dernière valeur. Nouvel essai après 30 s, 1, 2 puis 5 minutes,
  jamais plus vite que l'intervalle.
- **Registres absents** : un bloc que le régulateur ne sert pas (par
  exemple l'énergie sur certains modèles) n'est plus demandé jusqu'au
  redémarrage ; un bloc qui échoue ponctuellement est signalé dans l'écran
  de configuration, les autres valeurs sont publiées quand même.
- **Un seul ISG** par intégration ; l'appareil est identifié par la famille
  du régulateur (WPM ou LWZ), Modbus ne donnant ni numéro de série ni
  adresse MAC.
- Les requêtes Modbus partent une à la fois ; chaque réponse est vérifiée
  (numéro de transaction, unité, fonction, taille).
- Pas encore : circuits de chauffage 2 à 5, rafraîchissement, ventilation
  des LWZ, SG Ready, pompes à chaleur individuelles d'un WPMsystem.
- Les journaux ne contiennent jamais les valeurs des registres.

## Crédits

Portage de [pystiebeleltron](https://github.com/ThyMYthOS/python-stiebel-eltron)
(Martin Fuchs et contributeurs, MIT, version 0.9.2), la bibliothèque de
l'intégration STIEBEL ELTRON de Home Assistant. Licence Apache-2.0.
