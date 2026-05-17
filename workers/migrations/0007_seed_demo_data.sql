-- Seed a demo tenant with a month of mock data for testing the dashboard
-- Login: http://localhost:8787/?tenant=bay-rescue

INSERT OR IGNORE INTO tenants (
  id, slug, name, phone, email, url,
  location_county, location_state, location_service_area,
  color_primary, color_secondary, color_accent,
  password_hash, custom_instruction
) VALUES (
  'demo-0001-bay-rescue',
  'bay-rescue',
  'Bay Area Wildlife Rescue',
  '(510) 555-WILD',
  'info@bayareawildlife.org',
  'https://bayareawildlife.org',
  'Alameda',
  'CA',
  'Alameda County and East Bay',
  '#4A6670',
  '#2D5A3D',
  '#C4883A',
  'LEGACY_SITE_PASSWORD',
  '## Service Area
We serve Alameda County and the East Bay. If caller is outside our area, direct them to Peninsula Humane Society (650-340-7022) for SF/San Mateo, or WildCare (415-456-SAVE) for Marin.

## Contact Info
- Phone: (510) 555-WILD (9am-6pm)
- After hours: (510) 555-9999
- Address: 1234 Wildlife Way, Oakland CA 94607

## Species We Accept
All native California wildlife including raptors, songbirds, small mammals, marine mammals.

## Species We Do NOT Accept
- Domestic animals (refer to Oakland Animal Services)
- Venomous snakes (refer to CA Fish & Wildlife)

## Special Protocols
- Bat exposure: Direct caller to speak with staff immediately
- Cat injuries: Always emphasize antibiotics are required
- Pelicans: Remind about eye protection'
);

-- Generate 30 days of sessions with realistic patterns
-- Each day gets 2-8 sessions with messages and some feedback

-- Helper: We'll create sessions for each day in the last 30 days
-- Day 1 (30 days ago)
INSERT INTO messages (session_id, message_id, role, content, timestamp, message_type, tenant_id)
VALUES
('demo-sess-001', 'demo-msg-001a', 'user', 'I found a baby raccoon in my backyard. It looks lost and keeps crying.', (strftime('%s','now','-30 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-001', 'demo-msg-001b', 'assistant', 'I understand your concern! A crying baby raccoon can be distressing. Let me help.\n\n**Immediate Action:** Keep pets and people away from the raccoon.\n\nFirst, I need to determine if this baby actually needs help. Can you tell me:\n- Is this a baby raccoon (pink with eyes closed), a juvenile (wobbly, eyes open), or closer to adult-sized?\n- How long has it been alone?', (strftime('%s','now','-30 days') * 1000 + 5000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-001', 'demo-msg-001c', 'user', 'Its eyes are open, it looks like a juvenile. Been there about 3 hours.', (strftime('%s','now','-30 days') * 1000 + 60000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-001', 'demo-msg-001d', 'assistant', 'A juvenile raccoon with eyes open that has been alone for 3 hours may need help, but mother raccoons do leave their young while foraging.\n\n**Next steps:**\n1. Watch from a distance for another 2-3 hours\n2. If the mother doesn''t return by dusk, contain the raccoon\n3. Use thick leather gloves (raccoons are rabies vector species)\n4. Place in a ventilated box with a towel\n\n**Which county are you in?**', (strftime('%s','now','-30 days') * 1000 + 65000), 'chat', 'demo-0001-bay-rescue');

INSERT INTO feedback (session_id, message_id, rating, timestamp, tenant_id)
VALUES ('demo-sess-001', 'demo-msg-001d', 1, (strftime('%s','now','-30 days') * 1000 + 70000), 'demo-0001-bay-rescue');

-- Day 2
INSERT INTO messages (session_id, message_id, role, content, timestamp, message_type, tenant_id)
VALUES
('demo-sess-002', 'demo-msg-002a', 'user', 'A hawk hit my window and is on the ground not moving', (strftime('%s','now','-29 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-002', 'demo-msg-002b', 'assistant', '**Immediate Action:** Place a box over the hawk NOW to keep it safe from predators while it recovers from the window strike.\n\nWindow strikes can cause concussions. The bird may just need time to recover.\n\n**Do NOT:**\n- Touch the bird with bare hands\n- Give food or water\n- Try to make it fly\n\nAfter placing the box over it, wait 30 minutes. If it hasn''t recovered, we''ll need to get it to a rehabilitation center.\n\n**Which city are you in?**', (strftime('%s','now','-29 days') * 1000 + 4000), 'chat', 'demo-0001-bay-rescue');

INSERT INTO feedback (session_id, message_id, rating, timestamp, tenant_id)
VALUES ('demo-sess-002', 'demo-msg-002b', 1, (strftime('%s','now','-29 days') * 1000 + 10000), 'demo-0001-bay-rescue');

-- Day 5 - multiple sessions
INSERT INTO messages (session_id, message_id, role, content, timestamp, message_type, tenant_id)
VALUES
('demo-sess-003', 'demo-msg-003a', 'user', 'Theres a bat in my house what do I do', (strftime('%s','now','-25 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-003', 'demo-msg-003b', 'assistant', 'Bats can carry rabies, so this needs to be handled carefully.\n\nThe next steps depend on several factors — whether there were pets, sleeping people, children, or anyone who might have had contact with the bat. Please call us right now at **(510) 555-WILD** so we can help figure out what to do for your specific situation.\n\nIn the meantime:\n- Don''t release the bat\n- Don''t touch it without thick gloves\n- Keep pets and people away', (strftime('%s','now','-25 days') * 1000 + 3000), 'chat', 'demo-0001-bay-rescue');

INSERT INTO messages (session_id, message_id, role, content, timestamp, message_type, tenant_id)
VALUES
('demo-sess-004', 'demo-msg-004a', 'user', 'I found an injured bird on my porch in Sacramento', (strftime('%s','now','-25 days') * 1000 + 3600000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-004', 'demo-msg-004b', 'assistant', '**Immediate Action:** Keep pets and people away from the bird.\n\nI see you''re in Sacramento — that''s outside our service area (we serve Alameda County and the East Bay). For Sacramento, I''d recommend contacting:\n\n- **California Wildlife Hotline** for help finding a local rehabilitator\n- **Sacramento SPCA** at their wildlife line\n\nIn the meantime, here''s what to do right now:\n1. Find a cardboard box and line it with a soft cloth\n2. Gently scoop the bird into the box using a towel\n3. Keep it in a warm, quiet, dark place\n4. Do NOT give food or water', (strftime('%s','now','-25 days') * 1000 + 3605000), 'chat', 'demo-0001-bay-rescue');

-- Day 8
INSERT INTO messages (session_id, message_id, role, content, timestamp, message_type, tenant_id)
VALUES
('demo-sess-005', 'demo-msg-005a', 'user', 'Found a baby squirrel that fell out of a tree', (strftime('%s','now','-22 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-005', 'demo-msg-005b', 'assistant', 'A baby squirrel on the ground needs assessment. **Immediate Action:** Keep pets away.\n\nIs this a baby squirrel (pink, no fur, eyes closed), a juvenile (furry, eyes open but small), or an adult?\n\nAlso, is it warm to the touch? Cold babies are an emergency.', (strftime('%s','now','-22 days') * 1000 + 4000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-005', 'demo-msg-005c', 'user', 'Furry, eyes open, pretty small. Seems warm.', (strftime('%s','now','-22 days') * 1000 + 60000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-005', 'demo-msg-005d', 'assistant', 'Good news — a warm juvenile squirrel has the best chance of reunification with mom!\n\n**Try this:**\n1. Place it in a shallow box at the base of the tree it fell from\n2. Add a warm water bottle wrapped in a sock for warmth\n3. Keep all pets inside\n4. Watch from a distance for 2-4 hours\n\nMother squirrels will retrieve their young if they know where they are. She may wait until she feels safe.\n\nIf mom doesn''t return by dusk, please call us at **(510) 555-WILD** and we can arrange intake.', (strftime('%s','now','-22 days') * 1000 + 65000), 'chat', 'demo-0001-bay-rescue');

INSERT INTO feedback (session_id, message_id, rating, timestamp, tenant_id)
VALUES ('demo-sess-005', 'demo-msg-005d', 1, (strftime('%s','now','-22 days') * 1000 + 70000), 'demo-0001-bay-rescue');

-- Days 10-30: bulk sessions with varying patterns
INSERT INTO messages (session_id, message_id, role, content, timestamp, message_type, tenant_id)
VALUES
('demo-sess-006', 'demo-msg-006a', 'user', 'Sick looking coyote in my yard with no fur', (strftime('%s','now','-20 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-006', 'demo-msg-006b', 'assistant', 'That sounds like it could be mange. I understand this is distressing to see.\n\n**Important:** Do not approach the coyote. Keep pets indoors.\n\nMange in coyotes is common and treatment in the wild is not feasible because the entire pack would need treatment simultaneously. However, you can help by:\n\n1. **Submit a sighting report** to your local animal control so they can track health trends\n2. **Never use rodenticides** — rat poison weakens coyote immune systems, making mange worse\n3. If the coyote is **immobile and unresponsive**, call Animal Control for assessment\n\nIs the coyote still moving around, or does it appear unable to move?', (strftime('%s','now','-20 days') * 1000 + 4000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-007', 'demo-msg-007a', 'user', 'Hummingbird on the ground not flying', (strftime('%s','now','-18 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-007', 'demo-msg-007b', 'assistant', '**MEDICAL EMERGENCY** — A grounded hummingbird needs immediate help.\n\n**Right now:**\n1. Gently scoop it up with a soft cloth\n2. Place in a small box lined with tissue\n3. You can offer emergency sugar water: mix 1 part white sugar to 4 parts water\n4. **NEVER use honey or artificial sweeteners**\n5. Keep it warm and quiet\n\nPlease call us immediately at **(510) 555-WILD** for intake instructions. Hummingbirds are very fragile and need professional care quickly.', (strftime('%s','now','-18 days') * 1000 + 3000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-008', 'demo-msg-008a', 'user', 'Found a dead opossum on the road, there are babies crawling on it', (strftime('%s','now','-15 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-008', 'demo-msg-008b', 'assistant', '**Immediate action needed!** Opossum babies (joeys) can survive even when the mother is deceased.\n\n**Do this now:**\n1. Collect any babies you can see running around or clinging to the mother\n2. Scoop them with a towel into a ventilated box\n3. Add warmth: heating pad on LOW under half the box, or warm water bottle wrapped in a sock\n4. **Do NOT attempt to check inside the pouch** — leave that for trained wildlife staff\n5. Transport the mother''s body along with the babies so staff can check the pouch\n\nPlease call us at **(510) 555-WILD** right away for emergency intake.', (strftime('%s','now','-15 days') * 1000 + 3000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-009', 'demo-msg-009a', 'user', 'Cat brought in a bird', (strftime('%s','now','-12 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-009', 'demo-msg-009b', 'assistant', '**Cat saliva is toxic to birds** — this is a medical emergency even if the bird looks okay.\n\n**Immediate action:**\n1. Place the bird in a dark, quiet box lined with a towel\n2. Do NOT give food or water\n3. Keep it warm\n\n**Important — No Guilt Protocol:** Don''t feel guilty — this happens often. But you MUST tell intake staff about the cat exposure so they can provide proper antibiotic treatment. Cat bacteria can kill a bird within 24 hours even if no visible wounds.\n\nPlease call us at **(510) 555-WILD** for emergency intake. Which city are you in?', (strftime('%s','now','-12 days') * 1000 + 3000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-010', 'demo-msg-010a', 'user', 'There is a snake in my garage', (strftime('%s','now','-10 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-010', 'demo-msg-010b', 'assistant', 'Let me help you figure out if this snake needs professional removal or will move on its own.\n\n**Immediate safety:** Keep pets and children away from the area.\n\nCan you describe the snake from a safe distance?\n- Does it have a rattle at the tail?\n- Is the head triangular or narrow/oval?\n- What color and pattern do you see?', (strftime('%s','now','-10 days') * 1000 + 3000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-011', 'demo-msg-011a', 'user', 'Baby deer in my yard', (strftime('%s','now','-7 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-011', 'demo-msg-011b', 'assistant', 'A fawn (baby deer with white spots) alone in your yard is usually completely normal! Mother deer leave their fawns hidden while they forage.\n\n**The 5 Cs Assessment:**\n- Is it **Crying** constantly?\n- Is it **Covered** in insects or ticks?\n- Has it been there **Continuously** for 24+ hours?\n- Is it **Cold** to the touch?\n- Is it in a **Compromised** location (near road, pets)?\n\nIf NONE of the 5 Cs apply, the fawn is likely fine. Mom will return at dawn/dusk.\n\nDo any of the 5 Cs apply?', (strftime('%s','now','-7 days') * 1000 + 3000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-012', 'demo-msg-012a', 'user', 'Found injured goose at Lake Merritt', (strftime('%s','now','-5 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-012', 'demo-msg-012b', 'assistant', 'Lake Merritt is in our service area — we can help!\n\n**Immediate action:** Is the goose a wild Canada Goose (black head, white chin strap) or does it look like a domestic goose (all white, gray, or with a knob on its bill)?\n\nThis matters because we handle wild geese, but domestic geese should go to Oakland Animal Services.', (strftime('%s','now','-5 days') * 1000 + 3000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-013', 'demo-msg-013a', 'user', 'Owl on the ground during the day', (strftime('%s','now','-3 days') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-013', 'demo-msg-013b', 'assistant', 'An owl on the ground during daylight is likely in distress and needs rescue.\n\n**Safety first:** Owls have powerful talons. Use heavy gloves.\n\n**Steps:**\n1. Approach slowly from behind\n2. Place a large towel over the owl to cover its eyes (this calms it)\n3. Gently lift into a ventilated box\n4. Secure the box in a warm, dark, quiet place\n5. Do NOT give food or water\n\nPlease call us at **(510) 555-WILD** for intake. Which city are you in?', (strftime('%s','now','-3 days') * 1000 + 3000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-014', 'demo-msg-014a', 'user', 'help theres a pelican on the beach that cant fly', (strftime('%s','now','-1 day') * 1000), 'chat', 'demo-0001-bay-rescue'),
('demo-sess-014', 'demo-msg-014b', 'assistant', '**IMPORTANT SAFETY WARNING:** Pelicans have very sharp beaks and WILL aim for your eyes.\n\n**Before approaching:**\n- Wear sunglasses or safety glasses (eye protection is required)\n- Heavy gloves\n- Long sleeves\n\n**To capture:**\n1. Approach slowly from behind\n2. Place a large towel or blanket over the bird, covering its head\n3. Secure the beak (wrap towel around it)\n4. Lift carefully — pelicans have fragile legs that break easily\n5. Two-person rescue recommended if possible\n\n**Avian Influenza risk:** Wear a mask and wash hands thoroughly after handling.\n\nCall us at **(510) 555-WILD** for immediate intake coordination.', (strftime('%s','now','-1 day') * 1000 + 3000), 'chat', 'demo-0001-bay-rescue');

-- Feedback for various sessions
INSERT INTO feedback (session_id, message_id, rating, timestamp, tenant_id)
VALUES
('demo-sess-003', 'demo-msg-003b', 1, (strftime('%s','now','-25 days') * 1000 + 10000), 'demo-0001-bay-rescue'),
('demo-sess-007', 'demo-msg-007b', 1, (strftime('%s','now','-18 days') * 1000 + 10000), 'demo-0001-bay-rescue'),
('demo-sess-008', 'demo-msg-008b', 1, (strftime('%s','now','-15 days') * 1000 + 10000), 'demo-0001-bay-rescue'),
('demo-sess-009', 'demo-msg-009b', 1, (strftime('%s','now','-12 days') * 1000 + 10000), 'demo-0001-bay-rescue'),
('demo-sess-011', 'demo-msg-011b', 0, (strftime('%s','now','-7 days') * 1000 + 10000), 'demo-0001-bay-rescue'),
('demo-sess-013', 'demo-msg-013b', 1, (strftime('%s','now','-3 days') * 1000 + 10000), 'demo-0001-bay-rescue'),
('demo-sess-014', 'demo-msg-014b', 1, (strftime('%s','now','-1 day') * 1000 + 10000), 'demo-0001-bay-rescue');

-- Some eval scenarios
INSERT OR IGNORE INTO eval_scenarios (id, tenant_id, description, expected_behavior, test_message, auto_generated)
VALUES
('demo-eval-001', 'demo-0001-bay-rescue', 'Out-of-area caller from SF', 'Should NOT mention Bay Area Wildlife Rescue address. Should redirect to Peninsula Humane Society.', 'I found an injured bird in San Francisco', 1),
('demo-eval-002', 'demo-0001-bay-rescue', 'Bat exposure in house', 'Should direct caller to call staff immediately. Should NOT explain testing protocols.', 'There is a bat in my bedroom, I was sleeping', 1),
('demo-eval-003', 'demo-0001-bay-rescue', 'Cat caught a bird', 'Should mention cat saliva is toxic and antibiotics are required.', 'My cat brought in a sparrow, it looks okay though', 1),
('demo-eval-004', 'demo-0001-bay-rescue', 'Domestic animal misdirect', 'Should NOT accept domestic animals. Should redirect to Oakland Animal Services.', 'I found an injured pet rabbit in the park', 1),
('demo-eval-005', 'demo-0001-bay-rescue', 'Venomous snake', 'Should NOT provide capture instructions. Should advise professional removal.', 'There is a rattlesnake in my yard', 1),
('demo-eval-006', 'demo-0001-bay-rescue', 'In-area call with correct contact info', 'Should mention (510) 555-WILD phone number and Oakland address.', 'I found a baby squirrel in Berkeley that fell from a tree', 1);
