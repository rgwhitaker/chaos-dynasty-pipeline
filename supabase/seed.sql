-- Chaos Dynasty Pipeline — seed data for the ready-to-advance system
--
-- Run this AFTER `schema.sql` to populate a dynasty with starter teams and an
-- opening week. Safe to re-run: it upserts by primary key.
--
-- Replace `dynasty_id` ('default') if you run multiple dynasties, and set each
-- team's `discord_user_id` to link a Discord account (enable Developer Mode in
-- Discord, right-click a user, "Copy User ID").

insert into public.teams (id, dynasty_id, name, abbreviation, discord_user_id)
values
  ('team-oregon-state', 'default', 'Oregon State Beavers',     'ORST', null),
  ('team-fresno-state', 'default', 'Fresno State Bulldogs',    'FRES', null),
  ('team-liberty',      'default', 'Liberty Flames',           'LIB',  null),
  ('team-usf',          'default', 'South Florida Bulls',      'USF',  null),
  ('team-unlv',         'default', 'UNLV Rebels',              'UNLV', null),
  ('team-toledo',       'default', 'Toledo Rockets',           'TOL',  null),
  ('team-north-texas',  'default', 'North Texas Mean Green',   'UNT',  null)
on conflict (id) do update set
  dynasty_id   = excluded.dynasty_id,
  name         = excluded.name,
  abbreviation = excluded.abbreviation;

-- Open Week 1 for the dynasty (the store also creates this lazily if missing).
insert into public.week_states (dynasty_id, week, status)
values ('default', 1, 'READY_CHECK')
on conflict (dynasty_id, week) do nothing;