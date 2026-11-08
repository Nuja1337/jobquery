import type { AtsKind } from '@shared/types'

// Boards that answered on their public APIs on 2026-11-07. The names are what the boards report, or
// the usual spelling of the company. Each one can be added to the watch list as it is.

export type StarterGroup = 'games' | 'tech'

export interface StarterBoard {
  ats: AtsKind
  token: string
  name: string
  group: StarterGroup
}

const board = (ats: AtsKind, group: StarterGroup, token: string, name: string): StarterBoard => ({ ats, token, name, group })

export const STARTER_PACK: StarterBoard[] = [
  // Games
  board('greenhouse', 'games', 'riotgames', 'Riot Games'),
  board('greenhouse', 'games', 'naughtydog', 'Naughty Dog'),
  board('greenhouse', 'games', 'scopely', 'Scopely'),
  board('greenhouse', 'games', '2k', '2K'),
  board('greenhouse', 'games', 'rockstargames', 'Rockstar Games'),
  board('greenhouse', 'games', 'epicgames', 'Epic Games'),
  board('greenhouse', 'games', 'bungie', 'Bungie'),
  board('greenhouse', 'games', 'roblox', 'Roblox'),
  board('greenhouse', 'games', 'sonyinteractiveentertainmentglobal', 'PlayStation Global'),
  board('greenhouse', 'games', 'crystaldynamics', 'Crystal Dynamics'),
  board('greenhouse', 'games', 'gearbox', 'Gearbox'),
  board('greenhouse', 'games', 'remedy', 'Remedy'),
  board('greenhouse', 'games', 'housemarque', 'Housemarque'),
  board('greenhouse', 'games', 'firesprite', 'Firesprite'),
  board('lever', 'games', 'jamcity', 'Jam City'),
  board('lever', 'games', 'kabam', 'Kabam'),
  board('lever', 'games', 'mistplay', 'Mistplay'),
  board('lever', 'games', 'theorycraftgames', 'Theorycraft Games'),
  board('lever', 'games', 'immutable', 'Immutable'),
  board('ashby', 'games', 'thatgamecompany', 'thatgamecompany'),
  board('ashby', 'games', 'gardens', 'Gardens'),
  board('smartrecruiters', 'games', 'Ubisoft2', 'Ubisoft'),
  board('smartrecruiters', 'games', 'Gameloft', 'Gameloft'),
  board('smartrecruiters', 'games', 'KeywordsStudios', 'Keywords Studios'),

  // Tech, Greenhouse
  board('greenhouse', 'tech', 'discord', 'Discord'),
  board('greenhouse', 'tech', 'figma', 'Figma'),
  board('greenhouse', 'tech', 'stripe', 'Stripe'),
  board('greenhouse', 'tech', 'cloudflare', 'Cloudflare'),
  board('greenhouse', 'tech', 'datadog', 'Datadog'),
  board('greenhouse', 'tech', 'dropbox', 'Dropbox'),
  board('greenhouse', 'tech', 'reddit', 'Reddit'),
  board('greenhouse', 'tech', 'twitch', 'Twitch'),
  board('greenhouse', 'tech', 'airbnb', 'Airbnb'),
  board('greenhouse', 'tech', 'coinbase', 'Coinbase'),
  board('greenhouse', 'tech', 'robinhood', 'Robinhood'),
  board('greenhouse', 'tech', 'lyft', 'Lyft'),
  board('greenhouse', 'tech', 'instacart', 'Instacart'),
  board('greenhouse', 'tech', 'pinterest', 'Pinterest'),
  board('greenhouse', 'tech', 'spacex', 'SpaceX'),
  board('greenhouse', 'tech', 'vercel', 'Vercel'),
  board('greenhouse', 'tech', 'anthropic', 'Anthropic'),
  board('greenhouse', 'tech', 'scaleai', 'Scale AI'),
  board('greenhouse', 'tech', 'databricks', 'Databricks'),
  board('greenhouse', 'tech', 'mongodb', 'MongoDB'),
  board('greenhouse', 'tech', 'elastic', 'Elastic'),
  board('greenhouse', 'tech', 'gitlab', 'GitLab'),
  board('greenhouse', 'tech', 'twilio', 'Twilio'),
  board('greenhouse', 'tech', 'okta', 'Okta'),
  board('greenhouse', 'tech', 'asana', 'Asana'),
  board('greenhouse', 'tech', 'brex', 'Brex'),
  board('greenhouse', 'tech', 'affirm', 'Affirm'),
  board('greenhouse', 'tech', 'chime', 'Chime'),
  board('greenhouse', 'tech', 'duolingo', 'Duolingo'),
  board('greenhouse', 'tech', 'peloton', 'Peloton'),
  board('greenhouse', 'tech', 'squarespace', 'Squarespace'),
  board('greenhouse', 'tech', 'carta', 'Carta'),
  board('greenhouse', 'tech', 'gusto', 'Gusto'),
  board('greenhouse', 'tech', 'lattice', 'Lattice'),
  board('greenhouse', 'tech', 'flexport', 'Flexport'),
  board('greenhouse', 'tech', 'samsara', 'Samsara'),
  board('greenhouse', 'tech', 'nuro', 'Nuro'),
  board('greenhouse', 'tech', 'waymo', 'Waymo'),
  board('greenhouse', 'tech', 'warp', 'Warp'),
  board('greenhouse', 'tech', 'airtable', 'Airtable'),
  board('greenhouse', 'tech', 'calendly', 'Calendly'),
  board('greenhouse', 'tech', 'tenstorrent', 'Tenstorrent'),
  board('greenhouse', 'tech', 'lightmatter', 'Lightmatter'),

  // Tech, Ashby
  board('ashby', 'tech', 'ramp', 'Ramp'),
  board('ashby', 'tech', 'notion', 'Notion'),
  board('ashby', 'tech', 'linear', 'Linear'),
  board('ashby', 'tech', 'openai', 'OpenAI'),
  board('ashby', 'tech', 'cursor', 'Cursor'),
  board('ashby', 'tech', 'replit', 'Replit'),
  board('ashby', 'tech', 'modal', 'Modal'),
  board('ashby', 'tech', 'supabase', 'Supabase'),
  board('ashby', 'tech', 'posthog', 'PostHog'),
  board('ashby', 'tech', 'cohere', 'Cohere'),
  board('ashby', 'tech', 'perplexity', 'Perplexity'),
  board('ashby', 'tech', 'elevenlabs', 'ElevenLabs'),
  board('ashby', 'tech', 'runway', 'Runway'),
  board('ashby', 'tech', 'pika', 'Pika'),
  board('ashby', 'tech', 'midjourney', 'Midjourney'),
  board('ashby', 'tech', 'character', 'Character'),
  board('ashby', 'tech', 'harvey', 'Harvey'),
  board('ashby', 'tech', 'sierra', 'Sierra'),
  board('ashby', 'tech', 'decagon', 'Decagon'),
  board('ashby', 'tech', 'abridge', 'Abridge'),
  board('ashby', 'tech', 'gamma', 'Gamma'),
  board('ashby', 'tech', 'attio', 'Attio'),
  board('ashby', 'tech', 'whop', 'Whop'),
  board('ashby', 'tech', 'kalshi', 'Kalshi'),
  board('ashby', 'tech', 'polymarket', 'Polymarket'),
  board('ashby', 'tech', 'valon', 'Valon'),
  board('ashby', 'tech', 'saronic', 'Saronic'),
  board('ashby', 'tech', 'boom', 'Boom'),

  // Tech, other systems
  board('lever', 'tech', 'spotify', 'Spotify'),
  board('lever', 'tech', 'palantir', 'Palantir'),
  board('lever', 'tech', 'matchgroup', 'Match Group'),
  board('smartrecruiters', 'tech', 'ServiceNow', 'ServiceNow'),
  board('rippling', 'tech', 'rippling', 'Rippling')
]

/** The whole pack, or one group of it. */
export function starterPack(group?: StarterGroup): StarterBoard[] {
  return group ? STARTER_PACK.filter((b) => b.group === group) : [...STARTER_PACK]
}

/** The pack's name for a board, or null when the board is not in the pack. */
export function starterName(ats: AtsKind, token: string): string | null {
  const key = token.toLowerCase()
  return STARTER_PACK.find((b) => b.ats === ats && b.token.toLowerCase() === key)?.name ?? null
}
