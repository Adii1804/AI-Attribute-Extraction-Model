import { VLMProvider, FashionExtractionRequest } from '../../../types/vlm';
import { EnhancedExtractionResult, AttributeData } from '../../../types/extraction';
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface GoogleVisionConfig {
  model: 'gemini-2.5-pro' | 'gemini-2.5-flash' | 'gemini-2.0-flash' | 'gemini-pro-vision' | 'gemini-3-pro-image-preview';
  maxTokens: number;
  temperature: number;
  timeout: number;
}

export class GoogleVisionProvider implements VLMProvider {
  public readonly name = 'Google Gemini Vision';
  private config: GoogleVisionConfig;
  private client: GoogleGenerativeAI | null = null;

  constructor(config?: Partial<GoogleVisionConfig>) {
    this.config = {
      model: 'gemini-2.5-pro',  // Highest quality model for maximum accuracy
      maxTokens: 12000,  // Maximum tokens for comprehensive analysis
      temperature: 0.0,  // Zero temperature for maximum consistency
      timeout: 60000,  // 60 seconds for thorough processing
      ...config
    };
    this.initializeClient();
  }

  private initializeClient(): void {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (apiKey) {
      this.client = new GoogleGenerativeAI(apiKey);
      console.log('✅ Google Vision provider initialized successfully');
    } else {
      console.log('⚠️ Google Vision provider: API key not configured');
    }
  }

  async extractAttributes(request: FashionExtractionRequest): Promise<EnhancedExtractionResult> {
    const startTime = Date.now();
    console.log(`🔍 [Google ${this.config.model}] Starting extraction with ${request.schema.length} attributes`);
    
    if (!this.client) {
      throw new Error('Google Vision API client not initialized. Please set GOOGLE_API_KEY');
    }

    try {
      let ocrMetadata: Record<string, any> | null = null;
      try {
        const ocrPrompt = this.buildOcrPrompt(request);
        const ocrResponse = await this.callGeminiVision(request.image, ocrPrompt);
        ocrMetadata = this.parseOcrResponse(ocrResponse.content);
        if (ocrMetadata) {
          console.log('🧾 [OCR] Pre-pass metadata extracted');
        }
      } catch (ocrError) {
        console.warn('⚠️ [OCR] Pre-pass failed, continuing with main extraction');
      }

      const prompt = this.buildPrompt(request, ocrMetadata || undefined);
      const response = await this.callGeminiVision(request.image, prompt);
      
      const { attributes, extractedMetadata } = await this.parseResponse(response.content, request.schema, ocrMetadata || undefined);
      const confidence = this.calculateConfidence(attributes);

      const processingTime = Date.now() - startTime;
      const extractedCount = Object.values(attributes).filter(attr => attr !== null).length;
      
      console.log(`✅ [Google Vision] Extraction complete: ${extractedCount}/${Object.keys(attributes).length} attributes, ${processingTime}ms`);
      console.log(`📊 [Google Vision] Performance: Confidence=${confidence}%, Tokens=${response.tokensUsed}`);

      return {
        attributes,
        confidence,
        tokensUsed: response.tokensUsed,
        modelUsed: this.config.model as any,
        processingTime,
        discoveries: [],
        discoveryStats: {
          totalFound: 0,
          highConfidence: 0,
          schemaPromotable: 0,
          uniqueKeys: 0
        },
        extractedMetadata: extractedMetadata || undefined
      };
    } catch (error) {
      console.error(`❌ [Google Vision] Extraction failed:`, error instanceof Error ? error.message : 'Unknown error');
      throw new Error(`Google Vision extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async isHealthy(): Promise<boolean> {
    return this.client !== null && !!process.env.GOOGLE_API_KEY;
  }

  async configure(config: Partial<GoogleVisionConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
    this.initializeClient();
  }

  private buildPrompt(request: FashionExtractionRequest, ocrHint?: Record<string, any>): string {
    const { schema, categoryName, department, subDepartment } = request;
    
    const categoryContext = categoryName 
      ? `\nCATEGORY: ${categoryName} (${department}/${subDepartment})`
      : '';

    // Build schema with COMPLETE allowed values list - AI MUST use ONLY these values
    const schemaDefinition = schema.map(item => {
      const allowedValues = item.allowedValues?.length
        ? `\n  📌 ONLY USE THESE VALUES: ${item.allowedValues.map(av => {
            if (typeof av === 'string') return av;
            const shortForm = av.shortForm || '';
            const fullForm = av.fullForm || '';
            return fullForm && shortForm ? `${shortForm} (${fullForm})` : (shortForm || fullForm);
          }).join(' | ')}`
        : '';
      return `- ${item.key}: ${item.label}${allowedValues}`;
    }).join('\n');

    const ocrHintBlock = ocrHint ? `

OCR_HINTS (from dedicated OCR pre-pass — use ONLY for OCR-ONLY fields):
${Object.entries(ocrHint)
  .filter(([_, v]) => v !== null && v !== undefined && v !== '')
  .map(([k, v]) => `• ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  .join('\n')}
Rules for OCR_HINTS:
• Use OCR_HINTS ONLY for: division, vendor_name, design_number, ppt_number, rate, size, major_category, gsm, yarn_01, yarn_02, fabric_main_mvgr, colour
• If OCR_HINTS are unclear or conflict with your own OCR read, return null for that field (do not guess)
` : '';

    return `YOU ARE A FASHION ATTRIBUTE DATABASE LOOKUP SYSTEM.

🤖 YOUR IDENTITY:
• You are NOT a creative AI - you are a STRICT LOOKUP MACHINE
• Your brain ONLY contains the allowed values from the database below
• You CANNOT make up values, use approximations, or provide generic answers
• You CANNOT use "yes", "no", "present", "visible", or any generic terms
• If a value is not in your database → return NULL (leave blank)
• If you are unsure → return NULL (leave blank)
• You ONLY return EXACT values from the allowed list below
• If both short and full forms exist, RETURN the SHORT FORM (e.g., "MTL_ZIP")

🎯 TASK: Extract ${schema.length} attributes from this ${categoryName || 'garment'}.${categoryContext}

⚠️ CRITICAL RULES:
• EVERY value MUST be from the "ONLY USE THESE VALUES" list below
• NO generic answers like "yes", "no", "present", "visible", "standard"
• NO creative thinking - ONLY match what you see to database values
• If unsure or not in database → NULL
• EXACT spelling and case from database required
• PATTERN must use only PATTERN allowed values (do NOT use solid/printed/AOP/abstract/heather/polka unless they are explicitly in PATTERN)
• PATTERN: Do NOT default to BASIC. Use BASIC only if garment is truly plain with no cut-sew panels, no layers, no contrast blocks, no design structure. If unsure, return NULL.

PATTERN DEFINITIONS (use ONLY these if visible):
  • 1 LAYER = single-layer garment construction
  • 2 CUT N SEW = two fabric panels stitched together
  • 2 HORIZONTAL CUT N SEW = two panels joined horizontally
  • 2 LAYER = two fabric layers (outer + lining/overlay)
  • 2 VERTICAL CUT N SEW = two panels joined vertically
  • 3 CUT N SEW = three stitched panels
  • 3 HORIZONTAL CUT N SEW = three panels joined horizontally
  • 3 LAYER = three fabric layers
  • 3 VERTICAL CUT N SEW = three panels joined vertically
  • 4 LAYER = four fabric layers
  • A LINE = fitted top, flared bottom (A-shape)
  • AFGHANI = dropped crotch, gathered bottom
  • ANGARAKHA = wrap-style overlapping panels with ties
  • ASYMMETRICAL = uneven hem/neck/panel design
  • BIKER = biker-inspired styling
  • BOMBER = short jacket with ribbed cuffs/hem
  • BASIC = simple, clean design with no structure
  • CUT AND SEW = garment assembled from multiple pieces (C&S)
  • CAPRI = cropped bottoms below knee
  • CARGO = utility pockets
  • CHURIDAR = fitted bottom with gathers at ankle
  • CROP = short length exposing waist
  • DHOTI = draped bottom with pleats
  • DRAWER = loose bottom with elastic waistband
  • DANGRI = dungaree/bib-front one-piece
  • ENGINIEERED STRIPE = intentionally placed stripes (use dataset spelling)
  • 1_LYR / 2_LYR / 3_LYR / 4_LYR = fabric layer count (use dataset spelling if present)
  • 2_C&S / 3_C&S = number of cut-and-sew panels (use dataset spelling if present)
  • H_C&S = horizontal cut & sew (panels joined horizontally)
  • V_C&S = vertical cut & sew (panels joined vertically)
  • FEEDING = nursing openings
  • FISH CUT = fitted, flared at bottom
  • FLAIR = wide, flowing bottom
  • FRONT OPEN = full front opening (zip/button)
  • FRONT OPEN BUTTON = front open with buttons
  • FROCK = dress
  • FROCK STYLE = frock silhouette
  • FRK / FRK_STL = frock / frock style (use dataset spelling if present)
  • FRNCH = french styling or seams (use dataset spelling if present)
  • FRENCHY = frenchy style
  • HIGH N LOW = shorter front, longer back hem
  • HALTER = straps tie behind neck
  • H&L = high–low hem (use dataset spelling if present)
  • JODHPURI = structured traditional style
  • JOGGER = elastic waist + cuffed hem
  • JHABLA = loose infant/kids top
  • JACKET = outerwear
  • KAFTAN = loose flowing garment
  • KARACHI = loose traditional silhouette
  • KOTI = sleeveless vest-style
  • MONKEY = full-body one-piece (kidswear)
  • OFF SHOULDER = neckline exposing shoulders
  • OFF_SHLDR = off-shoulder (use dataset spelling if present)
  • PHULKARI = traditional embroidered floral pattern
  • CHIKANKARI = lucknow embroidery style (use dataset spelling if present)
  • PHULKARI = traditional embroidered floral pattern
  • PINTUCK = narrow stitched folds
  • PLEATED = structured pleats
  • PUFFER = padded quilted jacket
  • PUSH UP = enhancing/lifting structure (innerwear)
  • RVSL = reversible (use dataset spelling if present)
  • SEAMLESS = minimal/no seams
  • SMKNG = smocking elastic stitch texture (use dataset spelling if present)
  • SHRG = shirring elastic gathers (use dataset spelling if present)
  • ROMPER = one-piece top + shorts
  • RUFFLES = gathered flounces
  • REVERSIBLE = wearable both sides
  • SEAMLESS = minimal/no seams
  • SMOKING = smocking elastic stitch texture
  • STOLE = long narrow scarf
  • THONGS = minimal-coverage innerwear
  • TRUNK = fitted men’s innerwear
  • TUBE = strapless straight neckline
  • TUNIC = long top below hips
  • WIRED = support wires (bras)
  • WITH_INNER = attached inner/lining (use dataset spelling if present)

EMBROIDERY TECHNIQUE DEFINITIONS (use ONLY if visible/identifiable):
  • DORI EMBROIDERY = raised cords/dori stitched on fabric; rope-like continuous lines, 3D, outline motifs
  • EMBROIDERY TAPE = flat narrow tapes stitched onto fabric; ribbon-like, smooth, low height
  • GOTTA PATTI = shiny metallic gold/silver ribbons cut into shapes and stitched; high shine, traditional motifs
  • LACE ALL OVER PRINT = full surface covered with lace texture/pattern; continuous repeating lace
  • SWAROVSKI WORK = small precision-cut crystals; sharp sparkle and refraction
  • STONE WORK = stones attached; raised texture, less sharp shine than crystals
  • CUT WORK = fabric cut-outs with stitched edges; visible holes/negative space patterns
  • MIRROR WORK = small mirror pieces stitched with thread borders; bright reflective spots
  • ZARI EMBROIDERY = metallic thread stitching; dense, gold/silver thread sheen
  • SEQUINS WORK = flat shiny discs; soft shimmer, overlapping discs
  • BEADS = small beads stitched; rounded texture, raised points
  • THREAD WORK = embroidery only with thread; no stones/beads/mirrors

EMBROIDERY TYPE DEFINITIONS (use ONLY if visible/identifiable):
  • BRAND EMBROIDERY = brand logo/name/wordmark; clean precise lettering, corporate look
  • FLORAL EMBROIDERY = flowers/leaves/vines; organic curves, botanical motifs
  • PAISLEY EMBROIDERY = teardrop/mango-shaped motifs; intricate inner details, traditional
  • TROPICAL EMBROIDERY = palm leaves/exotic flowers/fruits; bright, vacation theme
  • CARTOON EMBROIDERY = playful characters/icons; bold outlines, simplified shapes
  • ANIMAL EMBROIDERY = animals/birds/insects; realistic or stylized motifs

PRINT TECHNIQUE DEFINITIONS (use ONLY if visible/identifiable):
  • DISCHARGE PRINT = dye removed from dyed fabric to create lighter/white designs; soft, breathable, vintage look, no ink feel
  • FLOCK PRINT = velvety raised texture using short fiber particles; suede/velour touch, luxury surface
  • FOIL PRINT = metallic foil heat-pressed onto fabric; glossy gold/silver, high shine
  • BAGRU PRINT = traditional Rajasthan hand block print using natural dyes; ethnic, earthy, heritage textile
  • DIGITAL PRINT = inkjet high‑resolution, complex designs; sharp details, photo‑realistic, unlimited colors
  • ROTARY PRINT = industrial rotating cylinder print; seamless repeats, mass‑produced, consistent alignment
  • PIGMENT PRINT = pigment ink sits on top of fabric; matte finish, slightly stiff hand feel
  • HOOD (HOODIE CONSTRUCTION) = garment feature (attached hood); NOT a print technique
  • SUBLIMATION PRINT = heat‑transfer ink becomes part of fabric (polyester); no texture, vibrant colors, all‑over
  • RUBBER PRINT = thick elastic raised print; rubbery touch, bold graphics, streetwear
  • PLASTIC SOLE PRINT = heavy PVC‑based print; very solid, glossy, 3D effect, high thickness
  • KHADI FABRIC = hand‑spun/hand‑woven natural fabric (cotton/silk); breathable, handcrafted textile
  • SHIMMER PRINT = sparkle/glitter particles; festive shine, glamorous texture
  • PUFF PRINT = heat‑reactive ink raises when cured; soft 3D effect
  • EMBOSS PRINT = pressed/raised pattern without heavy ink; tonal, luxury minimal texture
  • REFLECTIVE PRINT = ink reflects light; sportswear/safety, night visibility

PRINT TYPE STRICT RULES (CRITICAL):
  • Output print_type ONLY if a clear printed/graphic/patterned motif is visible on the garment
  • Do NOT treat texture, weave, knit structure, self-jacquard, tonal emboss, or fabric grain as a print
  • If no print is visible, set print_type = null, print_style = null, print_placement = null
  • If unsure, return null (never guess a print)

NOT IN DATASET → RETURN NULL (do not use): BK LESS, MUFFLER, SHRUG/SHRUGS, WITH INNER

📋 YOUR DATABASE (These are the ONLY values you know):
${schemaDefinition}
${ocrHintBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔬 MANDATORY ANALYSIS PROTOCOL (FOLLOW EXACTLY):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 0: GARMENT TYPE IDENTIFICATION (CRITICAL FIRST STEP)
🎯 Look at the image and identify the EXACT garment category:
   
   TOPWEAR: T-shirt, Shirt, Blouse, Top, Sweatshirt, Hoodie, Jacket, Blazer, Sweater, Cardigan
   BOTTOMWEAR: Jeans, Pants, Trousers, Shorts, Skirt, Leggings, Joggers, Track Pants
   FULL BODY: Dress, Jumpsuit, Romper, Saree, Kurta Set, Co-ord Set, Overall
   INNERWEAR: Bra, Panty, Brief, Boxers, Vest, Camisole
   ACCESSORIES: Belt, Scarf, Cap, Hat

⚠️ CONDITIONAL ATTRIBUTE EXTRACTION RULES:
   
  IF TOPWEAR (shirts, t-shirts, tops, jackets, etc.):
    ✅ Extract: neck, neck_details, collar, placket, sleeve, pocket_type, fit, pattern, length, 
            bottom_fold, button, zipper, zip_colour, print_type, print_style, print_placement, 
            patches, patches_type, embroidery, embroidery_type, wash, colour, front_open_style
    ❌ Skip: drawcord, father_belt, child_belt

    NECK DETAIL DEFINITIONS (use ONLY if visible):
      • DTM RIB NK = DYED/ DYEABLE RIB NECK (same color as garment)
      • CNT RIB NK = CONTRAST RIB NECK
      • RAW EDGE NK = RAW EDGE NECK
      • ZARA NK = ZARA NECK
      • BRAND RIB NK = BRAND RIB NECK
      • LOGO RIB NK = LOGO RIB NECK
      • TPNG RIB NK = TIPPING RIB NECK
      • JACQ RIB NK = JAQUARD RIB NECK
      • RIB TPNG NK = RIB TIPPING NECK
      • RIB CUT TPNG NK = RIB CUT TIPPING NECK
      • RN HUD = ROUND NECK HOOD
      • VN HUD = V-NECK HOOD
      • HNL_NK 2 BTN = HENLEY NECK – 2 BUTTON
      • HNL_NK 3 BTN = HENLEY NECK – 3 BUTTON
      • HNL_NK 5 BTN = HENLEY NECK – 5 BUTTON
      • RN ZIP = ROUND NECK ZIP
      • ENVLP NK = ENVELOPE NECK
      • MANDARIAN NK = MANDARIN NECK
      • SNAP BTN SHLDR NK = SNAP BUTTON SHOULDER NECK
   
   IF BOTTOMWEAR (jeans, pants, shorts, skirts, etc.):
      ✅ Extract: pocket_type, fit, pattern, length, bottom_fold, drawcord, button, zipper, 
                 zip_colour, print_type, print_style, print_placement, patches, patches_type, 
           embroidery, embroidery_type, wash, colour, father_belt, child_belt
      ❌ Skip: neck, neck_details, collar, placket, sleeve
    🔎 Belt rule: choose father_belt from allowed list based on waistband (elastic/inner/outer/fixed/adjustable). If elastic, also choose child_belt_detail when visible.

   CHILD BELT DETAIL DEFINITIONS (use ONLY if visible):
     • SLF GTHR BLT = self fabric waistband gathered with elastic
     • SLF RELX BLT = soft self fabric waistband with relaxed/loose elastic
     • TOP BLT TPNG = tipping line along top edge
     • DTM RIB BLT = ribbed waistband dyed to match garment color
     • CNT RIB BLT = ribbed waistband in contrast color
     • TPNG RIB BLT = ribbed waistband with tipping lines
     • BRND RIB BLT = ribbed waistband with branding pattern/text
     • SELF C&S BLT = self fabric cut-and-sew waistband (non-rib)
     • RIB & SLF C&S BLT = mixed rib + self fabric waistband
     • SLF CTRT BLT = self fabric waistband in contrast color
     • RIB CTRT BLT = ribbed waistband in contrast color
     • BRND ELS BLT = elastic waistband with branding
     • BRND LG BLT = waistband with brand logo
     • ELS CTRT BLT = elastic waistband in contrast color
     • CTRT_FLAT_KNIT = flat-knit waistband in contrast color
     • ROLL_UP = roll-up waistband/hem detail
   
   IF FULL BODY (dresses, jumpsuits, etc.):
      ✅ Extract: ALL 27 ATTRIBUTES (full body garments may have all features)
   
   IF INNERWEAR/ACCESSORIES:
      ✅ Extract: fit, pattern, colour, print_type, print_style, embroidery, wash
      ❌ Skip: Most structural attributes (use judgment based on item)

📝 For attributes you skip, return:
   "attribute_name": null  (DO NOT extract if not applicable to garment type)

STEP 1: IMAGE ANALYSIS (Based on garment type identified in STEP 0)
├─ Identify EXACT garment type from image
├─ Locate all visible construction details
├─ Read any visible tags/labels
└─ Match what you see to DATABASE VALUES ONLY

STEP 2: ZONE-BY-ZONE DETAILED INSPECTION
├─ NECK/COLLAR AREA:
│   • What type of neckline? (crew/v-neck/collar/hooded/turtleneck)
│   • Collar style if present? (spread/point/button-down/mandarin)
│   • Any neck details? (ribbing/binding/trim/placket)
│
├─ FRONT CLOSURE:
│   • How does it close? (buttons/zipper/pullover/snap/hook)
│   • Placket type? (hidden/exposed/fly front/no placket)
│   • If zipper is at the neckline/front opening, placket MUST be a ZIP PLACKET (ZIP PLKT / CON. ZIP PLKT / GOLD ZIP PLKT / SLV ZIP PLKT)
│   • Button material and count? (plastic/metal/wooden)
│   • Zipper type and color? (metal/plastic/exposed/hidden)
│
├─ SLEEVES (if applicable):
│   • Length? (sleeveless/short/3-4/long/extra long)
│   • Style? (set-in/raglan/dolman/cap)
│   • Cuff type? (plain/ribbed/button/elastic)
│
├─ POCKETS:
│   • How many pockets total? Count each one
│   • Type? (patch/welt/flap/zipper/5-pocket denim/kangaroo)
│   • Placement? (chest/side/back/coin)
│   • Do NOT confuse a neckline zipper/placket with a pocket. If no pocket bag is visible, return pocket_type = null.
│
├─ FIT & SILHOUETTE:
│   • Overall fit? (skinny/slim/regular/relaxed/oversized/loose)
│   • Length? (cropped/regular/long/extra long/full length)
│   • Rise (for bottoms)? (low/mid/high)
│   • For jeans: STRAIGHT FIT = consistent leg width from thigh to hem; REGULAR FIT = slightly relaxed through thigh with gentle taper
│   • If unsure between regular vs straight, return null (do NOT guess)
│   • Jeans rule: straight/regular cut → REG FIT; tapered/streamlined cut → SLIM FIT
│   • For jeans: STRAIGHT FIT = consistent leg width from thigh to hem; REGULAR FIT = slightly relaxed through thigh with gentle taper
│   • If unsure between regular vs straight, return null (do NOT guess)
│
├─ FABRIC & WASH:
│   • Fabric appearance? (denim/cotton/knit/woven/synthetic)
│   • Wash effect? (rinse/stone/acid/vintage/distressed/clean)
│   • Texture visible? (smooth/textured/brushed/raw)
│   • Denim rule: Do NOT use TWILL weave for denim/jeans (twill is for shirts/trousers only)
│
├─ EMBELLISHMENTS:
│   • Embroidery? Where and what design?
│   • Patches? Type and location?
│   • Prints? Type (graphic/stripe/floral), style, placement?
│   • Hardware? (rivets/studs/grommets/chains)
│
└─ BOTTOM DETAILS:
    • Hem style? (raw/folded/cuffed/ribbed)
    • Bottom fold/cuff present?
    • Drawcord? Where located?
    • Belt/waistband type? (elastic/inner elastic/outer elastic/fixed/adjustable)

BOTTOM_FOLD DEFINITIONS (use ONLY if visible):
  • BTM_ELS = BOTTOM ELASTIC
  • BTM_RIB = BOTTOM RIB
  • BTM OPEN = BOTTOM OPEN
  • SLF FOLD = SELF FOLD
  • UP_ FOLD = UP FOLD
  • TPNG = TIPPING
  • BTM_FRNG = BOTTOM FLARING
  • CONT_BTM_FLD = CONTRAST BOTTOM FOLD
  • RAW_EDGE = RAW EDGE
  • WITH ELASTIC & ADJUSTER = WITH ELASTIC & ADJUSTER
  • SMOKING = SMOCKING
  • SCALOP = SCALOP
  • LACE FINISH = LACE FINISH
  • RAW EDGE W OLOCK = RAW EDGE W O'LOCK
  • WD_ADJSTR = WAISTBAND ADJUSTER

STEP 3: TAG/LABEL READING (Critical for metadata)
├─ Look for WHITE BOARD/TAG in image
├─ OCR MODE = SCANNER:
│   • Read ALL visible board/tag text top-to-bottom, left-to-right (like a flatbed scanner)
│   • Preserve punctuation, dots, slashes, hyphens, and spacing exactly (e.g., "M.JEANS", "30-36", "L/XL")
│   • Do not hallucinate missing characters; if any character is unclear, leave the entire field null
│   • If multiple boards are present, use the closest/clearest board only
├─ Extract (OCR ONLY): Division, Vendor name, Design number, PPT number, Rate/Price, Size, Major category, GSM
├─ If the board has "FAB" or "FABRIC" line, parse into yarn_01, yarn_02, fabric_main_mvgr:
│   • If the FAB line ends with a bracketed token (e.g., "(...)") then IGNORE the bracket content
│     and output ONLY yarn_01 (from the first token). Set yarn_02 = null and fabric_main_mvgr = null.
│   • Split FAB value into 1–3 parts using separators (/ , - , | , space)
│   • 1 part → yarn_01 only; yarn_02 = null; fabric_main_mvgr = null
│   • 2 parts → first token is yarn_01 (preferred) OR yarn_02 (if only yarn_02 matches). Do NOT swap order.
│     Second token must match EITHER weave OR fabric_main_mvgr. If it matches only a yarn value, set yarn_02
│     and leave weave/fabric_main_mvgr null.
│   • 3 parts → yarn_01 = first; yarn_02 = second; fabric_main_mvgr = last
│   • Each part MUST match the allowed values for its attribute exactly; otherwise return null for that part
│   • If a token is not in the allowed list (e.g., abbreviations like "IMP"), return null (do not guess)
│   • YARN_01/YARN_02/FABRIC_MAIN_MVGR are OCR-ONLY. If no FAB/FABRIC line exists → set all three to null.
│   • If FAB contains "IMP" or "IMPORTED" → yarn_01 MUST be IMP (Imported). Do NOT output CP or any other yarn.
│     If IMP is not in allowed values, return null for yarn_01.
│   • If FAB indicates Imported, set weave = null (do NOT guess weave).
│   • If FAB has "LCE" or "LCR" in brackets, set lycra_non_lycra = LCR (only if LCR is an allowed value).
├─ Return division/gsm/yarn_01/yarn_02/fabric_main_mvgr under the attributes section using those keys
├─ Look for BRAND LABELS on garment
└─ Check CARE LABELS and SIZE TAGS
• For SIZE, preserve exactly what is written on the board (e.g., "S-XXL")
• For MAJOR CATEGORY, use OCR only (do NOT infer from garment). Preserve exact text/punctuation from the board (e.g., "M.JEANS").

COLOR OCR (SPECIAL RULE):
• Prefer the WHITE BOARD/TAG colour when present and valid in the database
• If the board colour is a close variant of what you see (same colour family), KEEP the board colour
• If the board colour is clearly wrong (e.g., board says BLU but garment is not blue), use the garment colour that matches the database
• First, locate a CLR/COLOR/COLOUR field on the board; extract its value exactly and map to database
• If CLR/COLOR/COLOUR exists but does NOT match any database value, scan the rest of the board text for a standalone colour token that matches the database
• If no board colour matches the database, fall back to garment colour ONLY if it matches a database value; otherwise return null
• Do NOT use OCR for any other attribute except: division, vendor_name, design_number, ppt_number, rate, size, major_category, gsm, yarn_01, yarn_02, fabric_main_mvgr
• Size must be returned exactly as written (e.g., "S-XXL", "30-36"), no normalization

LYCRA / NON-LYCRA (STRICT):
• Prefer OCR tags (e.g., LCR/LCE) when present; map to LCR only if allowed values include LCR
• If no OCR clue, set lycra_non_lycra only when stretch is visually obvious (leggings, body-hugging knits).
• If unsure, return null (do NOT guess)

WASH RULE (CRITICAL):
• Wash must be extracted from the garment appearance (fade/stone/acid/distressed) using ONLY WASH allowed values
• Do NOT output generic terms like "clean" or "solid" for wash
• If unsure, return null
• If the garment is clearly denim and no wash effect is visible, use RINSE

PATCH TYPE RULE (CRITICAL):
• Perform a close-up inspection of the patch area (mentally zoom/crop the patch) before deciding patch type
• Read any characters on the patch like OCR; prioritize detecting digits even if text is small or partially visible
• If the patch prominently contains numeric characters (0-9), classify PATCH TYPE as NUM (NUMERIC)
• This is true even if words are also present (e.g., "07 Athletic" → NUM)
• Use BRAND LOGO only when there are NO numbers and the patch is purely a brand/logo mark
• If uncertain, return null
• If the patch/text is blurry or unreadable, return null (never guess BRAND LOGO)
• Also set metadata.patchDigitsPresent = true if ANY digits are visible on the patch
• If metadata.patchDigitsPresent is true, PATCH TYPE MUST be NUM (do not output BRAND LOGO)

STEP 4: ATTRIBUTE EXTRACTION WITH REASONING
For EACHDATABASE LOOKUP (STRICT MATCHING ONLY)
For EACH APPLICABLE attribute (based on garment type from STEP 0):

🔍 MATCHING PROCESS:
1. Look at the garment feature
2. Search your database (allowed values list above) for EXACT match
3. If exact match found → return that value
4. If no exact match found → return NULL
5. If attribute doesn't apply to garment type → return NULL
6. If you're unsure → return NULL

🚨 ABSOLUTE RULES:
   • NO "yes" or "no" - these are NOT in your database
   • NO generic terms - ONLY specific database values
   • NO approximations - EXACT match or NULL
   • For TOPWEAR → bottom_fold, drawcord, belts = NULL
   • For BOTTOMWEAR → neck, collar, sleeve, placket = NULL

⚠️ VALUE FORMAT:
• rawValue: EXACT value from database (e.g., "STONE", "MTL_ZIP", "SLIM FIT", "PATCH_PKT")
• schemaValue: SAME as rawValue
• reasoning: Brief explanation of what you see and which database value you matched

EXAMPLES OF CORRECT MATCHING:
❌ WRONG: "rawValue": "yes" (NOT in database)
✅ CORRECT: "rawValue": "MTL" (from BUTTON allowed values)

❌ WRONG: "rawValue": "stone wash" (doesn't match database spelling)
✅ CORRECT: "rawValue": "STONE" (exact match from WASH allowed values)

❌ WRONG: "rawValue": "fly front" (not in database)
✅ CORRECT: "rawValue": "F_ZIP" (from FRONT_OPEN_STYLE allowed values)

❌ WRONG: "rawValue": "five pocket" (not exact match)
✅ CORRECT: "rawValue": "PATCH POCKET" (exact match from POCKET_TYPE allowed values)
STEP 5: QUALITY VERIFICATION (Self-check)
├─ Did I extract SPECIFIC values (not labels)?
├─ Did I avoid echoing attribute names?
├─ Are all confidences above 65% (or null)?
├─ Did I use fashion industry terminology?
└─ Is every value based on VISIBLE evidence?

━━ABSOLUTELY FORBIDDEN (AUTO-REJECTED):
   • ❌ "yes" or "no" - NOT database values
   • ❌ "present", "visible", "not visible" - NOT database values
   • ❌ "standard", "regular", "normal" - NOT database values (unless exact match in list)
   • ❌ Echoing attribute names: "neck": "Neck" ← NOT a database value
   • ❌ Descriptions: "fly front with button" ← NOT a database value
   • ❌ Approximations: "stone washed" instead of "STONE" ← NOT exact match
   • ❌ Creative answers ← You are NOT creative, you are a LOOKUP MACHINE
   • ❌ Values not in database ← AUTO-REJECTED by system
   • ❌ Spelling variations ← Must match EXACTLY

✅ YOUR ONLY ALLOWED BEHAVIOR:
   • ✅ LOOK at image → FIND exact match in database → RETURN that value
   • ✅ NO match found → RETURN null
   • ✅ Unsure → RETURN null
   • ✅ Copy database values EXACTLY (spelling, case, underscores, spaces)
   • ✅ Reasoning field explains what you saw and why you picked that database value
   • ✅ Think like a barcode scanner - match or no match, nothing in between
   • Match EXACT values from allowed list (case-sensitive preferred)
   • Save descriptions for reasoning field only ← CORRECT
   • Honest null values when confidence < 65% ← CORRECT
   • If perfect match not found in list, use closest EXACT match or null

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 FASHION TERMINOLOGY REFERENCE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NECK TYPES: crew neck, v-neck, scoop neck, boat neck, square neck, sweetheart, halter, cowl, turtleneck, mock neck
COLLAR TYPES: spread collar, point collar, button-down, mandarin, peter pan, shawl, notched, wingtip
SLEEVE TYPES: cap sleeve, short sleeve, 3/4 sleeve, long sleeve, sleeveless, raglan, dolman, bell, puff
FIT TYPES: skinny, slim, slim fit, regular fit, relaxed fit, loose fit, oversized, tailored, athletic fit
POCKET TYPES: 5-pocket (denim), patch pocket, welt pocket, flap pocket, zipper pocket, coin pocket, kangaroo
WASH TYPES: raw denim, rinse wash, light wash, medium wash, dark wash, stone wash, acid wash, vintage wash, distressed, bleached
PATTERN TYPES: solid, stripe, check, plaid, polka dot, floral, geometric, abstract, camo, tie-dye
LENGTH TYPES: cropped, regular, long, full length, ankle length, floor length, knee length, midi, maxi

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 REAL EXAMPLES (Non-applicable attributes = null):

BOTTOMWEAR EXAMPLE (JEANS):
{
  "neck": null,
  "neck_details": null,
  "collar": null,
  "placket": null,
  "sleeve": null,
  "front_open_style": null,
  "pocket_type": {
    "rawValue": "PATCH POCKET",
    "schemaValue": "PATCH POCKET",
    "visualConfidence": 95,
    "reasoning": "Two back patch pockets visible. Database match: POCKET_TYPE → PATCH POCKET"
  },
  "wash": {
    "rawValue": "STONE",
    "schemaValue": "STONE",
    "visualConfidence": 92,
    "reasoning": "Stone wash effect with fading visible. Database match: WASH → STONE"
  },
  "fit": {
    "rawValue": "SLIM FIT",
    "schemaValue": "SLIM FIT",
    "visualConfidence": 90,
    "reasoning": "Tapered leg opening, fitted through thigh. Database match: FIT → SLIM FIT"
  },
  "length": {
    "rawValue": "FULL LENGTH",
    "schemaValue": "FULL LENGTH",
    "visualConfidence": 88,
    "reasoning": "Full length jeans to ankle. Database match: LENGTH → FULL LENGTH"
  },
  "button": {
    "rawValue": "MTL",
    "schemaValue": "MTL",
    "visualConfidence": 93,
    "reasoning": "Metal button visible at waist. Database match: BUTTON → MTL"
  },
  "zipper": {
    "rawValue": "MTL_ZIP",
    "schemaValue": "MTL_ZIP",
    "visualConfidence": 94,
    "reasoning": "Metal zipper at fly. Database match: ZIPPER → MTL_ZIP"
  },
  "bottom_fold": {
    "rawValue": "SLF FOLD",
    "schemaValue": "SLF FOLD",
    "visualConfidence": 78,
    "reasoning": "Self-folded hem finish. Database match: BOTTOM_FOLD → SLF FOLD"
  },
  "drawcord": null,
  "colour": {
    "rawValue": "DNM_BLU",
    "schemaValue": "DNM_BLU",
    "visualConfidence": 96,
    "reasoning": "Dark denim blue color. Database match: COLOR → DNM_BLU"
  },
  "father_belt": null,
  "child_belt": null
}

TOPWEAR EXAMPLE (SHIRT):
{
  "neck": {
    "rawValue": "REG_CLR",
    "schemaValue": "REG_CLR",
    "visualConfidence": 94,
    "reasoning": "Regular collar at neckline. Database match: NECK → REG_CLR"
  },
  "collar": {
    "rawValue": "REG_CLR",
    "schemaValue": "REG_CLR",
    "visualConfidence": 94,
    "reasoning": "Regular spread collar. Database match: COLLAR → REG_CLR"
  },
  "sleeve": {
    "rawValue": "REG_SLV",
    "schemaValue": "REG_SLV",
    "visualConfidence": 97,
    "reasoning": "Regular full-length sleeves. Database match: SLEEVE → REG_SLV"
  },
  "placket": {
    "rawValue": "PLN PLKT",
    "schemaValue": "PLN PLKT",
    "visualConfidence": 95,
    "reasoning": "Plain vertical button placket. Database match: PLACKET → PLN PLKT"
  },
  "button": {
    "rawValue": "4HOLE_MTL_BTN",
    "schemaValue": "4HOLE_MTL_BTN",
    "visualConfidence": 96,
    "reasoning": "4-hole metal buttons on placket. Database match: BUTTON → 4HOLE_MTL_BTN"
  },
  "pocket_type": {
    "rawValue": "PATCH_PKT",
    "schemaValue": "PATCH_PKT",
    "visualConfidence": 90,
    "reasoning": "Patch pocket on left chest. Database match: POCKET_TYPE → PATCH_PKT"
  },
  "fit": {
    "rawValue": "REG FIT",
    "schemaValue": "REG FIT",
    "visualConfidence": 88,
    "reasoning": "Regular fit silhouette. Database match: FIT → REG FIT"
  },
  "front_open_style": {
    "rawValue": "6 BTN",
    "schemaValue": "6 BTN",
    "visualConfidence": 95,
    "reasoning": "6 buttons for front closure. Database match: FRONT_OPEN_STYLE → 6 BTN"
  },
  "bottom_fold": null,
  "drawcord": null,
  "father_belt": null,
  "child_belt": null
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 OUTPUT FORMAT (JSON only, no markdown):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{
  "metadata": {
    "vendorName": "string or null",
    "designNumber": "string or null",
    "pptNumber": "string or null",
    "price": "string or null",
    "size": "string or null",
    "majorCategory": "string or null",
    "patchText": "string or null",
    "patchDigitsPresent": "true | false | null"
  },
  "attributes": {
    "attribute_key": {
      "rawValue": "DATABASE VALUE or null",
      "schemaValue": "SAME AS RAW VALUE",
      "visualConfidence": 75,
      "reasoning": "what you saw + which database value matched"
    }
  }
}

{VALIDATION CHECKLIST:
□ Garment type identified correctly (TOPWEAR/BOTTOMWEAR/etc.)
□ Non-applicable attributes = null
□ ZERO "yes" or "no" values (NOT in database)
□ ZERO generic terms like "present", "visible", "standard"
□ EVERY value is EXACT match from database
□ NO spelling variations, NO approximations
□ If no exact database match found → null
□ Confidence ≥ 70% or null
□ Reasoning explains: "what I saw" + "which database value matched"
□ I behaved as a LOOKUP MACHINE, not a creative AI
      "schemaValue": "SAME AS RAW VALUE",
      "visualConfidence": 75,
      "reasoning": "detailed explanation of what you see and why you chose this value"
    }
  }
}

🚨 FINAL CHECKLIST BEFORE SUBMISSION:
□ STEP 0: Identified garment type (TOPWEAR/BOTTOMWEAR/FULL BODY/etc.)
□ Applied conditional extraction rules based on garment type
□ Set null for non-applicable attributes (e.g., no neck for jeans)
□ Every rawValue MUST be from the "ONLY USE THESE VALUES" list above
□ Every value is SHORT (2-4 words max, not sentences)
□ No attribute names echoed as values
□ All confidences ≥ 65% (or null)
□ Used EXACT values from allowed list (check spelling and case)
□ Based on VISIBLE evidence only
□ Detailed explanations ONLY in "reasoning" field
□ JSON is valid (no markdown, no code blocks)

GOAL: Achieve 90%+ accuracy. Take your time. Be thorough. Be precise.`;
  }

  private buildOcrPrompt(request: FashionExtractionRequest): string {
    return `YOU ARE A DOCUMENT OCR SCANNER.

TASK: Read ONLY the WHITE BOARD/TAG text in the image. Ignore the garment.

OCR RULES:
• Read text TOP-TO-BOTTOM, LEFT-TO-RIGHT
• Preserve punctuation, dots, slashes, hyphens, and spacing exactly
• Do NOT infer or fix spelling
• If any character in a field is unclear, set the entire field to null
• If multiple boards/tags exist, use the clearest/closest board only

Return JSON only (no markdown):
{
  "ocr": {
    "rawLines": ["line1", "line2"],
    "division": "string or null",
    "vendor_name": "string or null",
    "design_number": "string or null",
    "ppt_number": "string or null",
    "rate": "string or null",
    "size": "string or null",
    "major_category": "string or null",
    "gsm": "string or null",
    "fab_line": "string or null",
    "colour": "string or null"
  }
}

IMPORTANT:
• For size, return exactly what is written (e.g., "S-XXL", "30-36", "L/XL")
• For major_category, return exact text/punctuation (e.g., "M.JEANS")
• If a FAB/FABRIC line exists, copy the full line into fab_line (do NOT parse)
• If CLR/COLOR/COLOUR is present, copy the value into colour
• If no board/tag visible, return all fields as null
`;
  }

  private parseOcrResponse(content: string): Record<string, any> | null {
    try {
      const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(cleanContent);
      const ocr = parsed?.ocr;
      if (!ocr || typeof ocr !== 'object') return null;
      return ocr;
    } catch {
      return null;
    }
  }

  private async callGeminiVision(imageData: string, prompt: string): Promise<{ content: string; tokensUsed: number }> {
    if (!this.client) {
      throw new Error('Google Vision client not initialized');
    }

    const model = this.client.getGenerativeModel({ 
      model: this.config.model,
      generationConfig: {
        maxOutputTokens: this.config.maxTokens,
        temperature: this.config.temperature
      }
    });

    // Extract base64 data and mime type
    const base64Match = (/^data:(image\/[a-z]+);base64,(.+)$/).exec(imageData);
    if (!base64Match) {
      throw new Error('Invalid image data format');
    }

    const [, mimeType, base64Data] = base64Match;

    // Add timeout wrapper around generateContent
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Gemini API timeout (${this.config.timeout}ms) - request took too long`)), this.config.timeout);
    });

    const resultPromise = model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType,
          data: base64Data
        }
      }
    ]);

    const result = await Promise.race([resultPromise, timeoutPromise]);
    
    const response = (result as any).response;
    const text = response.text();
    
    // Gemini API provides usageMetadata with actual token counts
    const usage = response.usageMetadata;
    let tokensUsed = 0;
    
    if (usage) {
      // Use actual token counts from API response
      tokensUsed = (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0);
      console.log(`📊 [Gemini] Token Usage: Input=${usage.promptTokenCount}, Output=${usage.candidatesTokenCount}, Total=${tokensUsed}`);
    } else {
      // Fallback to estimation if usage data not available
      // Image tokens: ~258 tokens per image (Gemini's average)
      // Text tokens: ~4 characters per token
      const imageTokens = 258; // Standard estimate for images
      const promptTokens = Math.ceil(prompt.length / 4);
      const outputTokens = Math.ceil(text.length / 4);
      tokensUsed = imageTokens + promptTokens + outputTokens;
      console.log(`📊 [Gemini] Estimated Tokens: Image=${imageTokens}, Prompt=${promptTokens}, Output=${outputTokens}, Total=${tokensUsed}`);
    }

    return {
      content: text,
      tokensUsed: tokensUsed
    };
  }

  private async parseResponse(content: string, schema: any[], ocrHint?: Record<string, any>): Promise<{ attributes: AttributeData; extractedMetadata?: any }> {
    try {
      const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(cleanContent);
      
      const extractedMetadata = parsed.metadata || null;
      const attributeSource = parsed.attributes || parsed;
      
      const attributes: AttributeData = {};
      
      const metadataMapping: Record<string, string> = {
        'vendorName': 'vendor_name',
        'designNumber': 'design_number',
        'pptNumber': 'ppt_number',
        'price': 'rate',
        'size': 'size',
        'majorCategory': 'major_category',
        'division': 'division',
        'gsm': 'gsm'
      };

      const mergeNonNull = (base: Record<string, any>, incoming?: Record<string, any> | null) => {
        if (!incoming) return base;
        const merged = { ...base };
        for (const [k, v] of Object.entries(incoming)) {
          if (v !== null && v !== undefined && v !== '') {
            merged[k] = v;
          }
        }
        return merged;
      };

      const metadataObj = extractedMetadata && typeof extractedMetadata === 'object' ? extractedMetadata : null;
      const mergedMetadata = mergeNonNull(metadataObj ? { ...metadataObj } : {}, ocrHint);

      const metadataLower = mergedMetadata
        ? Object.fromEntries(Object.entries(mergedMetadata).map(([k, v]) => [String(k).toLowerCase(), v]))
        : {} as Record<string, any>;

      const metadataAliases: Record<string, string[]> = {
        vendor_name: ['vendorname', 'vendor_name', 'vendor name', 'vendor', 'brand'],
        design_number: ['designnumber', 'design_number', 'design number', 'design_no', 'design no', 'design'],
        ppt_number: ['pptnumber', 'ppt_number', 'ppt number', 'ppt_no', 'ppt no', 'ppt'],
        rate: ['rate', 'price', 'mrp', 'cost'],
        size: ['size', 'sizes', 'size_range', 'size range', 'size-range', 'siz'],
        major_category: ['majorcategory', 'major_category', 'major category', 'category']
      };

      const resolveMetadataValue = (schemaKey: string) => {
        const directKey = Object.keys(metadataMapping).find(k => metadataMapping[k] === schemaKey);
        let value = directKey && mergedMetadata ? (mergedMetadata as any)[directKey] : null;
        if (!value && directKey) {
          value = metadataLower[directKey.toLowerCase()];
        }
        if (!value && metadataAliases[schemaKey]) {
          for (const alias of metadataAliases[schemaKey]) {
            const found = metadataLower[alias.toLowerCase()];
            if (found) {
              value = found;
              break;
            }
          }
        }
        if (value && schemaKey === 'design_number') {
          const designStr = String(value).trim();
          // Remove trailing PLAN token (e.g., "ABC123 PLAN" or "ABC123 - PLAN")
          value = designStr.replace(/\s*[-_]?\s*PLAN\s*$/i, '').trim() || null;
        }
        return value ?? null;
      };

      if (mergedMetadata && typeof mergedMetadata === 'object') {
        const majorMeta = resolveMetadataValue('major_category');
        if (majorMeta && !('majorCategory' in mergedMetadata) && !('major_category' in mergedMetadata)) {
          (mergedMetadata as any).majorCategory = majorMeta;
        }
      }

      const getColorFamily = (value?: string | null): string | null => {
        if (!value) return null;
        const v = value.toLowerCase();
        if (v.includes('blu') || v.includes('blue') || v.includes('navy') || v.includes('sky') || v.includes('denim')) return 'blue';
        if (v.includes('gry') || v.includes('gray') || v.includes('grey') || v.includes('ash') || v.includes('charcoal')) return 'grey';
        if (v.includes('blk') || v.includes('black') || v.includes('jet')) return 'black';
        if (v.includes('wht') || v.includes('white') || v.includes('ivory')) return 'white';
        if (v.includes('red') || v.includes('maroon') || v.includes('wine') || v.includes('burg')) return 'red';
        if (v.includes('grn') || v.includes('green') || v.includes('olive') || v.includes('mint')) return 'green';
        if (v.includes('ylw') || v.includes('yellow') || v.includes('mustard')) return 'yellow';
        if (v.includes('org') || v.includes('orange') || v.includes('rust')) return 'orange';
        if (v.includes('pnk') || v.includes('pink') || v.includes('rose') || v.includes('peach')) return 'pink';
        if (v.includes('prp') || v.includes('purple') || v.includes('violet') || v.includes('lav')) return 'purple';
        if (v.includes('brn') || v.includes('brown') || v.includes('choco') || v.includes('tan')) return 'brown';
        if (v.includes('beige') || v.includes('cream') || v.includes('sand') || v.includes('nude')) return 'beige';
        return null;
      };
      
      for (const schemaItem of schema) {
        const key = schemaItem.key;

        if (key === 'colour') {
          const visualRaw = attributeSource?.[key]?.rawValue ?? attributeSource?.[key]?.schemaValue ?? null;
          const visualValidated = visualRaw ? this.validateAgainstAllowedValues(this.normalizeNullValue(visualRaw), schemaItem) : null;

          const metadataColor = mergedMetadata?.colour || mergedMetadata?.color || mergedMetadata?.clr || null;
          let boardValidated = metadataColor ? this.validateAgainstAllowedValues(metadataColor, schemaItem) : null;

          if (!boardValidated && mergedMetadata && typeof mergedMetadata === 'object') {
            const metadataText = Object.values(mergedMetadata)
              .filter(v => typeof v === 'string')
              .join(' ');
            boardValidated = this.validateAgainstAllowedValues(metadataText, schemaItem);
          }

          let finalColor: string | null = null;
          let reasoning = 'Colour not confidently matched';
          let confidence = 0;

          if (boardValidated && visualValidated) {
            const boardFamily = getColorFamily(boardValidated);
            const visualFamily = getColorFamily(visualValidated);

            if (!boardFamily || !visualFamily || boardFamily === visualFamily) {
              finalColor = boardValidated;
              reasoning = 'Board colour matches garment colour family; using board value';
              confidence = 85;
            } else {
              finalColor = visualValidated;
              reasoning = 'Board colour conflicts with garment appearance; using visual colour';
              confidence = attributeSource?.[key]?.visualConfidence ?? 78;
            }
          } else if (boardValidated) {
            finalColor = boardValidated;
            reasoning = 'Colour read from white board/tag (OCR)';
            confidence = 85;
          } else if (visualValidated) {
            finalColor = visualValidated;
            reasoning = 'Colour inferred from garment appearance';
            confidence = attributeSource?.[key]?.visualConfidence ?? 75;
          }

          attributes[key] = finalColor ? {
            rawValue: finalColor,
            schemaValue: finalColor,
            visualConfidence: confidence,
            isNewDiscovery: false,
            mappingConfidence: confidence,
            reasoning
          } : null;
          continue;
        }
        
        if (attributeSource[key]) {
          const rawValue = this.normalizeNullValue(attributeSource[key].rawValue);
          const schemaValue = this.normalizeNullValue(attributeSource[key].schemaValue);
          
          // 🚨 STRICT VALIDATION: Only accept values from allowed list
          const validatedValue = this.validateAgainstAllowedValues(rawValue, schemaItem);
          
          const fallbackConfidence = validatedValue ? (key === 'colour' || key === 'wash' ? 80 : 70) : 0;
          const visualConfidence = validatedValue
            ? (attributeSource[key].visualConfidence ?? fallbackConfidence)
            : 0;
          attributes[key] = {
            rawValue: validatedValue,
            schemaValue: validatedValue || schemaValue,
            visualConfidence,
            isNewDiscovery: false,
            mappingConfidence: visualConfidence,
            reasoning: validatedValue 
              ? attributeSource[key].reasoning 
              : `Value "${rawValue}" not found in allowed list - set to null`
          };
        } else if (mergedMetadata && Object.values(metadataMapping).includes(key)) {
          const value = resolveMetadataValue(key);
          
          if (value) {
            attributes[key] = {
              rawValue: value,
              schemaValue: value,
              visualConfidence: 95,
              isNewDiscovery: false,
              mappingConfidence: 95,
              reasoning: 'Extracted from visible tag/board'
            };
          } else {
            attributes[key] = null;
          }
        } else {
          attributes[key] = null;
        }
      }

      // Ensure major_category is populated from OCR metadata when available
      if (attributes.major_category === null) {
        const majorFromMeta = resolveMetadataValue('major_category');
        if (majorFromMeta) {
          attributes.major_category = {
            rawValue: majorFromMeta,
            schemaValue: majorFromMeta,
            visualConfidence: 95,
            isNewDiscovery: false,
            mappingConfidence: 95,
            reasoning: 'Extracted from visible tag/board'
          };
        }
      }

      // If FAB indicates Imported (yarn_01 = IMP/IMPORTED), force weave to null
      const yarnValue = attributes.yarn_01?.schemaValue || attributes.yarn_01?.rawValue || '';
      const yarnLower = typeof yarnValue === 'string' ? yarnValue.toLowerCase() : String(yarnValue).toLowerCase();
      if (yarnLower === 'imp' || yarnLower === 'imported') {
        attributes.weave = null;
      }

      // Denim rule: TWILL weave not allowed for jeans/denim
      const majorValue = String(attributes.major_category?.schemaValue || attributes.major_category?.rawValue || '').toLowerCase();
      const weaveValue = String(attributes.weave?.schemaValue || attributes.weave?.rawValue || '').toLowerCase();
      if (majorValue.includes('jean') || majorValue.includes('denim')) {
        if (weaveValue === 'twl' || weaveValue === 'twill' || weaveValue.includes('twill')) {
          attributes.weave = null;
        }
      }

      // Fallback: if wash missing, default to RINSE (dataset-safe) in simplified flow
      if (attributes.wash === null) {
        attributes.wash = {
          rawValue: 'RINSE',
          schemaValue: 'RINSE',
          visualConfidence: 70,
          isNewDiscovery: false,
          mappingConfidence: 70,
          reasoning: 'Wash not detected; defaulted to RINSE'
        };
      }

      // Print sanity: if no supporting print details, nullify print_type
      const printTypeKey = Object.keys(attributes).find(k => k.toLowerCase() === 'print_type');
      const printStyleKey = Object.keys(attributes).find(k => k.toLowerCase() === 'print_style');
      const printPlacementKey = Object.keys(attributes).find(k => k.toLowerCase() === 'print_placement');

      if (printTypeKey) {
        const hasPrintType = !!attributes[printTypeKey]?.rawValue;
        const hasPrintStyle = printStyleKey ? !!attributes[printStyleKey]?.rawValue : false;
        const hasPrintPlacement = printPlacementKey ? !!attributes[printPlacementKey]?.rawValue : false;
        const patternKey = Object.keys(attributes).find(k => k.toLowerCase() === 'pattern');
        const patternVal = patternKey ? String(attributes[patternKey]?.rawValue || '').toLowerCase() : '';

        if (hasPrintType && !hasPrintStyle && !hasPrintPlacement) {
          // If garment appears plain/basic, prefer null for print_type
          if (!patternVal || patternVal.includes('basic')) {
            attributes[printTypeKey] = null;
          }
        }
      }

      // Patch type override: if digits are visible on patch, force NUM
      const patchTypeKey = Object.keys(attributes).find(k => {
        const lower = k.toLowerCase();
        return lower === 'patch_type' || lower === 'patches_type';
      });

      if (patchTypeKey) {
        const patchMetaDigits = (mergedMetadata as any)?.patchDigitsPresent ??
          (mergedMetadata as any)?.patch_digits_present ??
          (mergedMetadata as any)?.patch_digits ?? null;
        const patchMetaText = (mergedMetadata as any)?.patchText ?? (mergedMetadata as any)?.patch_text ?? null;
        const patchDigitsFromMeta = typeof patchMetaDigits === 'boolean'
          ? patchMetaDigits
          : (typeof patchMetaDigits === 'string' ? /true/i.test(patchMetaDigits) : null);
        const patchDigitsFromText = typeof patchMetaText === 'string' ? /\d/.test(patchMetaText) : false;
        const reasoningText = typeof attributes[patchTypeKey]?.reasoning === 'string'
          ? attributes[patchTypeKey]?.reasoning
          : '';
        const digitsInReasoning = /\d/.test(reasoningText);

        if (patchDigitsFromMeta === true || patchDigitsFromText || digitsInReasoning) {
          attributes[patchTypeKey] = {
            rawValue: 'NUM',
            schemaValue: 'NUM',
            visualConfidence: Math.max(attributes[patchTypeKey]?.visualConfidence || 0, 75),
            isNewDiscovery: false,
            mappingConfidence: Math.max(attributes[patchTypeKey]?.mappingConfidence || 0, 75),
            reasoning: 'Patch contains numeric characters; PATCH TYPE forced to NUM'
          };
        }
      }
      
      return { attributes, extractedMetadata: mergedMetadata };
    } catch (error) {
      console.error('❌ [Google Vision] Failed to parse response:', error);
      throw new Error(`Failed to parse Google Vision response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 🚨 STRICT VALIDATION: Check if value exists in allowed values list
   * Returns the value if valid, null if not found in list
   */
  private validateAgainstAllowedValues(value: any, schemaItem: any): any {
    if (value === null || value === undefined) return null;
    
    // If no allowed values defined, accept any value (for TEXT type attributes)
    if (!schemaItem.allowedValues || schemaItem.allowedValues.length === 0) {
      return value;
    }
    
    const valueStr = String(value).trim();

    const allowedPairs = schemaItem.allowedValues.map((av: any) => {
      if (typeof av === 'string') return { shortForm: av, fullForm: av };
      return { shortForm: av.shortForm || '', fullForm: av.fullForm || av.shortForm || '' };
    }).filter((p: any) => p.shortForm || p.fullForm);

    const tryMatch = (candidate: string): string | null => {
      if (!candidate) return null;
      // Exact shortForm match
      const exactShort = allowedPairs.find((p: any) => p.shortForm === candidate);
      if (exactShort) return exactShort.shortForm;
      // Exact fullForm match
      const exactFull = allowedPairs.find((p: any) => p.fullForm === candidate);
      if (exactFull) return exactFull.shortForm || exactFull.fullForm;
      // Case-insensitive match
      const lower = candidate.toLowerCase();
      const ciShort = allowedPairs.find((p: any) => p.shortForm?.toLowerCase() === lower);
      if (ciShort) return ciShort.shortForm;
      const ciFull = allowedPairs.find((p: any) => p.fullForm?.toLowerCase() === lower);
      if (ciFull) return ciFull.shortForm || ciFull.fullForm;
      return null;
    };

    let matchedValue = tryMatch(valueStr);

    if (!matchedValue && schemaItem.key === 'colour') {
      const aliasMap: Record<string, string> = {
        'sky': 'SKY BLUE',
        'skyblue': 'SKY BLUE',
        'sky blue': 'SKY BLUE',
        'lt sky': 'LIGHT SKY BLUE',
        'light sky': 'LIGHT SKY BLUE',
        'light sky blue': 'LIGHT SKY BLUE',
        'denim blue': 'DENIM BLUE',
        'navy': 'NAVY BLUE',
        'navy blue': 'NAVY BLUE'
      };
      matchedValue = tryMatch(aliasMap[valueStr.toLowerCase()]);
    }

    if (!matchedValue && schemaItem.key === 'wash') {
      const aliasMap: Record<string, string> = {
        'clean': 'RINSE',
        'normal': 'RINSE',
        'plain': 'RINSE'
      };
      matchedValue = tryMatch(aliasMap[valueStr.toLowerCase()]);
    }

    if (!matchedValue && schemaItem.key === 'yarn_01') {
      const aliasMap: Record<string, string> = {
        'imported': 'IMP',
        'imp': 'IMP'
      };
      matchedValue = tryMatch(aliasMap[valueStr.toLowerCase()]);
    }
    
    if (matchedValue) {
      console.log(`✅ [Validation] Matched "${valueStr}" to allowed value "${matchedValue}"`);
      return matchedValue;
    }

    if (schemaItem.key === 'major_category') {
      console.log(`✅ [Validation] Accepting OCR major_category value "${valueStr}" (not in allowed list)`);
      return valueStr;
    }
    
    // Value not in allowed list - reject it
    console.warn(`⚠️ [Validation] REJECTED "${valueStr}" for ${schemaItem.key} - not in allowed values list`);
    return null;
  }

  /**
   * Normalize null/missing value variations to null
   */
  private normalizeNullValue(value: any): any {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return value;
    
    const lowerValue = value.toLowerCase().trim();
    const nullVariants = [
      'no_packet', 'no_placket', 'no plackets', 'no placket',
      'not visible', 'cannot determine', 'n/a', 'na',
      'not applicable', 'none', 'not found', 'unknown'
    ];
    
    if (nullVariants.includes(lowerValue)) {
      return null;
    }
    
    return value;
  }

  private calculateConfidence(attributes: AttributeData): number {
    const values = Object.values(attributes).filter(attr => attr !== null);
    if (values.length === 0) return 0;
    
    const totalConfidence = values.reduce((sum: number, attr: any) => sum + (attr?.visualConfidence || 0), 0);
    return Math.round(totalConfidence / values.length);
  }
}
