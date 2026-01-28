import { Request, Response, NextFunction } from 'express';
import { VLMService } from '../services/vlm/vlmService';
import { ImageProcessor } from '../utils/imageProcessor';
import { cacheService } from '../services/cacheService';
import { SchemaService } from '../services/schemaService';
import { prismaClient as prisma } from '../utils/prisma';
import type { SchemaItem, ExtractionRequest, EnhancedExtractionResult } from '../types/extraction';
import type { FashionExtractionRequest } from '../types/vlm';

export class EnhancedExtractionController {
  private vlmService = new VLMService();
  private schemaService = new SchemaService();

  private async persistExtractionJob(params: {
    image: string;
    schema: SchemaItem[];
    categoryName?: string;
    userId?: number;
    result: EnhancedExtractionResult;
  }) {
    try {
      const normalizeToken = (value?: string) =>
        String(value || '')
          .toLowerCase()
          .replace(/_/g, ' ')
          .replace(/\//g, ' ')
          .replace(/-/g, ' ')
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const expandTokens = (token: string) => {
        const tokens = new Set<string>([token]);
        if (token.includes('colour')) tokens.add(token.replace(/colour/g, 'color'));
        if (token.includes('color')) tokens.add(token.replace(/color/g, 'colour'));
        return Array.from(tokens);
      };

      const { image, schema, categoryName, userId, result } = params;
      const category = categoryName
        ? await prisma.category.findFirst({
            where: {
              OR: [
                { name: { contains: categoryName, mode: 'insensitive' } },
                { fullForm: { contains: categoryName, mode: 'insensitive' } }
              ]
            },
            select: { id: true }
          })
        : await prisma.category.findFirst({ select: { id: true } });

      const fallbackCategory = category
        ? category
        : await prisma.category.findFirst({ select: { id: true } });

      if (!fallbackCategory) return;

      const attributes = await prisma.masterAttribute.findMany({
        select: { id: true, key: true, label: true }
      });
      const attributeIdByKey = new Map<string, number>();
      attributes.forEach((attr) => {
        const keyToken = normalizeToken(attr.key);
        const labelToken = normalizeToken(attr.label || '');
        if (keyToken) {
          expandTokens(keyToken).forEach(t => attributeIdByKey.set(t, attr.id));
        }
        if (labelToken) {
          expandTokens(labelToken).forEach(t => attributeIdByKey.set(t, attr.id));
        }
      });

      const attributeEntries = Object.entries(result.attributes || {})
        .filter(([_, v]) => {
          const value = v as any;
          return value && (value.schemaValue ?? value.rawValue) !== null;
        })
        .map(([key, v]: [string, any]) => {
          const token = normalizeToken(key);
          const attributeId = attributeIdByKey.get(token);
          if (!attributeId) return null;
          const schemaValue = v.schemaValue ?? v.rawValue ?? null;
          const finalValue = schemaValue !== null && schemaValue !== undefined ? String(schemaValue) : null;
          return {
            attributeId,
            rawValue: v.rawValue ? String(v.rawValue) : null,
            finalValue,
            confidence: v.visualConfidence ?? null,
            extractionMethod: 'VLM',
          };
        })
        .filter(Boolean) as Array<{ attributeId: number; rawValue: string | null; finalValue: string | null; confidence: number | null; extractionMethod: string; }>;

      const majorMetaValue = (result.extractedMetadata as any)?.majorCategory
        ?? (result.extractedMetadata as any)?.major_category
        ?? null;
      if (majorMetaValue) {
        const majorToken = normalizeToken('major_category');
        const majorAltToken = normalizeToken('major category');
        const majorAttributeId = attributeIdByKey.get(majorToken) || attributeIdByKey.get(majorAltToken);
        const hasMajor = attributeEntries.some(entry => entry.attributeId === majorAttributeId);
        if (majorAttributeId && !hasMajor) {
          attributeEntries.push({
            attributeId: majorAttributeId,
            rawValue: String(majorMetaValue),
            finalValue: String(majorMetaValue),
            confidence: 95,
            extractionMethod: 'VLM'
          });
        }
      }

      const job = await prisma.extractionJob.create({
        data: {
          userId: userId ?? null,
          categoryId: fallbackCategory.id,
          imageUrl: image,
          status: 'COMPLETED',
          aiModel: result.modelUsed ?? null,
          processingTimeMs: result.processingTime ?? null,
          tokensUsed: result.tokensUsed ?? null,
          totalAttributes: schema.length,
          extractedCount: attributeEntries.length,
          avgConfidence: result.confidence ?? null,
          completedAt: new Date(),
        },
      });

      if (attributeEntries.length > 0) {
        await prisma.extractionResult.createMany({
          data: attributeEntries.map((entry) => ({
            jobId: job.id,
            attributeId: entry.attributeId,
            rawValue: entry.rawValue,
            finalValue: entry.finalValue,
            confidence: entry.confidence as any,
            extractionMethod: entry.extractionMethod,
          })),
        });
      }
    } catch (error) {
      console.warn('Failed to persist extraction history:', error);
    }
  }

  /**
   * Enhanced Multi-VLM Fashion Extraction from Upload
   */
  extractFromUploadVLM = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No image file provided',
          timestamp: Date.now()
        });
        return;
      }

      // Validate the image file
      ImageProcessor.validateImageFile(req.file);

      // Parse the request body
      const { 
        schema, 
        categoryName, 
        customPrompt, 
        discoveryMode, 
        department, 
        subDepartment,
        season,
        occasion 
      } = req.body;
      
      if (!schema) {
        res.status(400).json({
          success: false,
          error: 'Schema is required',
          timestamp: Date.now()
        });
        return;
      }

      let parsedSchema: SchemaItem[];
      try {
        parsedSchema = typeof schema === 'string' ? JSON.parse(schema) : schema;
      } catch (error) {
        res.status(400).json({
          success: false,
          error: 'Invalid schema format',
          timestamp: Date.now()
        });
        return;
      }

      // Convert image to base64
      const base64Image = await ImageProcessor.processImageToBase64(req.file);

      console.log(`Enhanced VLM Extraction Started - Category: ${categoryName}, Schema: ${parsedSchema.length} attrs`);

      // Create enhanced fashion extraction request
      const vlmRequest: FashionExtractionRequest = {
        image: base64Image,
        schema: parsedSchema,
        categoryName,
        customPrompt,
        discoveryMode: discoveryMode === 'true' || discoveryMode === true,
        department: department as any,
        subDepartment: subDepartment as any,
        season: season as any,
        occasion: occasion as any
      };

      // Extract using Multi-VLM pipeline
      const result = await this.vlmService.extractFashionAttributes(vlmRequest);

      console.log(`✅ Enhanced VLM Extraction Complete - Confidence: ${result.confidence}%, Time: ${result.processingTime}ms`);

      await this.persistExtractionJob({
        image: base64Image,
        schema: parsedSchema,
        categoryName,
        userId: req.user?.id,
        result
      });

      res.json({
        success: true,
        data: result,
        metadata: {
          enhancedMode: true,
          vlmPipeline: 'multi-model',
          fashionSpecialized: true
        },
        timestamp: Date.now()
      });

    } catch (error) {
      console.error('❌ Enhanced VLM extraction failed:', error);
      next(error);
    }
  };

  /**
   * Enhanced Multi-VLM Fashion Extraction from Base64
   */
  extractFromBase64VLM = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { 
        image, 
        schema, 
        categoryName, 
        customPrompt, 
        discoveryMode,
        forceRefresh,
        department,
        subDepartment,
        season,
        occasion
      }: ExtractionRequest & {
        department?: string;
        subDepartment?: string;
        season?: string;
        occasion?: string;
      } = req.body;

      if (!image) {
        res.status(400).json({
          success: false,
          error: 'Base64 image is required',
          timestamp: Date.now()
        });
        return;
      }

      if (!schema) {
        res.status(400).json({
          success: false,
          error: 'Schema is required',
          timestamp: Date.now()
        });
        return;
      }

      console.log(`Enhanced Base64 VLM Extraction - Discovery: ${discoveryMode}, Schema: ${schema.length} attrs, Force Refresh: ${forceRefresh}`);

      // � CACHING DISABLED - Always fetch fresh results
      const shouldUseCache = false; // Disabled caching
      
      // Cache checking code removed - always perform fresh extraction

      // Create enhanced fashion extraction request
      const vlmRequest: FashionExtractionRequest = {
        image,
        schema,
        categoryName,
        customPrompt,
        discoveryMode: discoveryMode || false,
        department: department as any,
        subDepartment: subDepartment as any,
        season: season as any,
        occasion: occasion as any
      };

      // Extract using Multi-VLM pipeline
      const result = await this.vlmService.extractFashionAttributes(vlmRequest);

      // 🚫 CACHING DISABLED - No caching of extraction results
      // const shouldCacheResult = false; // Disabled caching

      console.log(`✅ Enhanced Base64 VLM Complete - Confidence: ${result.confidence}%, Discoveries: ${result.discoveries?.length || 0}`);

      await this.persistExtractionJob({
        image,
        schema,
        categoryName,
        userId: req.user?.id,
        result
      });

      res.json({
        success: true,
        data: result,
        metadata: {
          enhancedMode: true,
          vlmPipeline: 'multi-model',
          fashionSpecialized: true,
          discoveryEnabled: discoveryMode,
          cached: false,
          forceRefresh: forceRefresh || false
        },
        timestamp: Date.now()
      });

    } catch (error) {
      console.error('❌ Enhanced Base64 VLM extraction failed:', error);
      next(error);
    }
  };

  /**
   * 🔬 Advanced VLM Analysis with Full Pipeline Debug
   */
  extractWithAdvancedVLM = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { 
        image, 
        schema, 
        categoryName,
        department,
        subDepartment
      }: ExtractionRequest & {
        department?: string;
        subDepartment?: string;
      } = req.body;

      if (!image || !schema) {
        res.status(400).json({
          success: false,
          error: 'Image and schema are required',
          timestamp: Date.now()
        });
        return;
      }

      console.log(`🔬 Advanced VLM Analysis - Full Pipeline Debug Mode`);

      // Advanced analysis with all VLM providers
      const vlmRequest: FashionExtractionRequest = {
        image,
        schema,
        categoryName,
        discoveryMode: true, // Always enable discovery for advanced analysis
        department: department as any,
        subDepartment: subDepartment as any
      };

      // Get provider health status
      const providerHealth = await this.vlmService.checkProviderHealth();

      // Extract using Multi-VLM pipeline
      const result = await this.vlmService.extractFashionAttributes(vlmRequest);

      console.log(`🔬 Advanced VLM Analysis Complete - Confidence: ${result.confidence}%`);

      res.json({
        success: true,
        data: result,
        debug: {
          providerHealth,
          pipelineUsed: 'multi-vlm-advanced',
          analysisDepth: 'comprehensive'
        },
        metadata: {
          advancedMode: true,
          allProvidersUsed: true,
          fullDebugInfo: true
        },
        timestamp: Date.now()
      });

    } catch (error) {
      console.error('❌ Advanced VLM analysis failed:', error);
      next(error);
    }
  };

  /**
   * 📊 VLM System Health Check
   */
  vlmHealthCheck = async (req: Request, res: Response) => {
    try {
      const healthStatus = await this.vlmService.checkProviderHealth();
      const healthySystems = Object.values(healthStatus).filter(Boolean).length;
      const totalSystems = Object.keys(healthStatus).length;

      res.json({
        success: true,
        message: `VLM System Status: ${healthySystems}/${totalSystems} providers healthy`,
        data: {
          providers: healthStatus,
          systemHealth: healthySystems / totalSystems,
          recommendation: this.getSystemRecommendation(healthStatus)
        },
        timestamp: Date.now(),
        version: '2.0.0-vlm'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'VLM health check failed',
        timestamp: Date.now()
      });
    }
  };

  /**
   * ⚙️ Configure VLM Providers
   */
  configureVLMProvider = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { providerId, config } = req.body;

      if (!providerId || !config) {
        res.status(400).json({
          success: false,
          error: 'Provider ID and configuration are required',
          timestamp: Date.now()
        });
        return;
      }

      await this.vlmService.configureProvider(providerId, config);

      res.json({
        success: true,
        message: `Provider ${providerId} configured successfully`,
        timestamp: Date.now()
      });

    } catch (error) {
      next(error);
    }
  };

  /**
   * 🔍 Get system recommendation based on provider health
   */
  private getSystemRecommendation(healthStatus: Record<string, boolean>): string {
    const healthy = Object.values(healthStatus).filter(Boolean).length;
    const total = Object.keys(healthStatus).length;

    if (healthy === total) {
      return 'All systems operational - optimal performance expected';
    } else if (healthy >= total * 0.75) {
      return 'Most systems operational - good performance expected';  
    } else if (healthy >= total * 0.5) {
      return 'Some systems down - reduced performance, fallbacks active';
    } else {
      return 'Multiple systems down - limited functionality, check configurations';
    }
  }

  /**
   * Enhanced Category-Based Extraction (Database-Driven Schema)
   * Loads schema from database based on category code
   */
  extractFromCategoryCode = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { 
        image, 
        categoryCode, 
        vendorName, 
        designNumber, 
        costPrice, 
        sellingPrice,
        notes,
        discoveryMode,
        customPrompt
      } = req.body;

      // Validate required fields
      if (!image) {
        res.status(400).json({
          success: false,
          error: 'Base64 image is required',
          timestamp: Date.now()
        });
        return;
      }

      if (!categoryCode) {
        res.status(400).json({
          success: false,
          error: 'Category code is required',
          timestamp: Date.now()
        });
        return;
      }

      console.log(`Category-Based Extraction Started - Code: ${categoryCode}`);

      // Load schema from database
      const { category, schema, stats } = await this.schemaService.getCategorySchema(categoryCode);

      console.log(`📊 Category: ${category.name} (${category.department.name} → ${category.subDepartment.name})`);
      console.log(`📋 Schema: ${stats.totalAttributes} attributes (${stats.aiExtractableCount} AI-extractable, ${stats.requiredCount} required)`);

      // Create enhanced fashion extraction request with garment type
      const vlmRequest: FashionExtractionRequest = {
        image,
        schema,
        categoryName: category.name,
        customPrompt,
        discoveryMode: discoveryMode === 'true' || discoveryMode === true || false,
        department: category.department.name.toLowerCase() as any,
        garmentType: category.garmentType, // NEW: For specialized prompts
        subDepartment: category.subDepartment.code as any
      };

      // Extract using Multi-VLM pipeline (existing service - no changes)
      const result = await this.vlmService.extractFashionAttributes(vlmRequest);

      console.log(`✅ Category-Based Extraction Complete - Confidence: ${result.confidence}%, Time: ${result.processingTime}ms`);

      // Merge extracted metadata with provided metadata (prefer extracted when available)
      const finalMetadata = {
        vendorName: result.extractedMetadata?.vendorName || vendorName || null,
        designNumber: result.extractedMetadata?.designNumber || designNumber || null,
        costPrice: result.extractedMetadata?.price || (costPrice ? parseFloat(costPrice) : null),
        sellingPrice: sellingPrice ? parseFloat(sellingPrice) : null,
        pptNumber: result.extractedMetadata?.pptNumber || null,
        notes,
        extractionDate: new Date().toISOString()
      };

      // Log if AI extracted metadata from image
      if (result.extractedMetadata) {
        console.log(`🏷️ AI extracted metadata from tag/board:`, result.extractedMetadata);
      }

      // Return result with category info and metadata
      // Persist extraction job + results (for history & products)
      try {
        const normalizeToken = (value?: string) =>
          String(value || '')
            .toLowerCase()
            .replace(/_/g, ' ')
            .replace(/\//g, ' ')
            .replace(/-/g, ' ')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const expandTokens = (token: string) => {
          const tokens = new Set<string>([token]);
          if (token.includes('colour')) tokens.add(token.replace(/colour/g, 'color'));
          if (token.includes('color')) tokens.add(token.replace(/color/g, 'colour'));
          return Array.from(tokens);
        };

        const attributeIdByKey = new Map<string, number>();
        schema.forEach((item: any) => {
          const id = item?._metadata?.attributeId;
          const keyToken = normalizeToken(item?.key);
          const labelToken = normalizeToken(item?.label);
          if (id && keyToken) expandTokens(keyToken).forEach(t => attributeIdByKey.set(t, id));
          if (id && labelToken) expandTokens(labelToken).forEach(t => attributeIdByKey.set(t, id));
        });

        if (!attributeIdByKey.has(normalizeToken('major_category'))) {
          const majorAttr = await prisma.masterAttribute.findFirst({
            where: { key: 'major_category' },
            select: { id: true, key: true, label: true }
          });
          if (majorAttr) {
            const keyToken = normalizeToken(majorAttr.key);
            const labelToken = normalizeToken(majorAttr.label || '');
            if (keyToken) expandTokens(keyToken).forEach(t => attributeIdByKey.set(t, majorAttr.id));
            if (labelToken) expandTokens(labelToken).forEach(t => attributeIdByKey.set(t, majorAttr.id));
          }
        }

        const attributeEntries = Object.entries(result.attributes || {})
          .filter(([_, v]) => v && (v.schemaValue ?? v.rawValue) !== null)
          .map(([key, v]: [string, any]) => {
            const token = normalizeToken(key);
            const attributeId = attributeIdByKey.get(token);
            if (!attributeId) return null;
            const schemaValue = v.schemaValue ?? v.rawValue ?? null;
            const finalValue = schemaValue !== null && schemaValue !== undefined ? String(schemaValue) : null;
            return {
              attributeId,
              rawValue: v.rawValue ? String(v.rawValue) : null,
              finalValue,
              confidence: v.visualConfidence ?? null,
              extractionMethod: 'VLM',
            };
          })
          .filter(Boolean) as Array<{ attributeId: number; rawValue: string | null; finalValue: string | null; confidence: number | null; extractionMethod: string; }>;

        const majorMetaValue = (result.extractedMetadata as any)?.majorCategory
          ?? (result.extractedMetadata as any)?.major_category
          ?? null;
        if (majorMetaValue) {
          const majorToken = normalizeToken('major_category');
          const majorAltToken = normalizeToken('major category');
          const majorAttributeId = attributeIdByKey.get(majorToken) || attributeIdByKey.get(majorAltToken);
          const hasMajor = attributeEntries.some(entry => entry.attributeId === majorAttributeId);
          if (majorAttributeId && !hasMajor) {
            attributeEntries.push({
              attributeId: majorAttributeId,
              rawValue: String(majorMetaValue),
              finalValue: String(majorMetaValue),
              confidence: 95,
              extractionMethod: 'VLM',
            });
          }
        }

        const extractedCount = attributeEntries.length;

        const job = await prisma.extractionJob.create({
          data: {
            userId: req.user?.id ?? null,
            categoryId: category.id,
            imageUrl: image,
            vendorName: finalMetadata.vendorName ?? null,
            designNumber: finalMetadata.designNumber ?? null,
            costPrice: finalMetadata.costPrice ?? null,
            sellingPrice: finalMetadata.sellingPrice ?? null,
            notes: finalMetadata.notes ?? null,
            status: 'COMPLETED',
            aiModel: result.modelUsed ?? null,
            processingTimeMs: result.processingTime ?? null,
            tokensUsed: result.tokensUsed ?? null,
            totalAttributes: schema.length,
            extractedCount,
            avgConfidence: result.confidence ?? null,
            completedAt: new Date(),
          },
        });

        if (attributeEntries.length > 0) {
          await prisma.extractionResult.createMany({
            data: attributeEntries.map((entry) => ({
              jobId: job.id,
              attributeId: entry.attributeId,
              rawValue: entry.rawValue,
              finalValue: entry.finalValue,
              confidence: entry.confidence as any,
              extractionMethod: entry.extractionMethod,
            })),
          });
        }
      } catch (persistError) {
        console.warn('Failed to persist extraction history:', persistError);
      }

      res.json({
        success: true,
        data: {
          ...result,
          category: {
            code: category.code,
            name: category.name,
            fullForm: category.fullForm,
            department: category.department.name,
            subDepartment: category.subDepartment.name,
            fabricDivision: category.fabricDivision
          },
          metadata: finalMetadata,
          schemaStats: stats
        },
        timestamp: Date.now()
      });

    } catch (error: any) {
      console.error('❌ Category-based extraction failed:', error);
      
      if (error.message?.includes('not found')) {
        res.status(404).json({
          success: false,
          error: error.message,
          timestamp: Date.now()
        });
        return;
      }
      
      next(error);
    }
  };

  /**
   * 📂 Get Category Hierarchy for Dropdown
   */
  getCategoryHierarchy = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      console.log('📂 Fetching category hierarchy...');
      const hierarchy = await this.schemaService.getCategoryHierarchy();
      
      console.log(`✅ Hierarchy loaded: ${hierarchy.stats.totalDepartments} depts, ${hierarchy.stats.totalSubDepartments} sub-depts, ${hierarchy.stats.totalCategories} categories`);
      
      res.json({
        success: true,
        data: hierarchy,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('❌ Failed to fetch hierarchy:', error);
      next(error);
    }
  };

  /**
   * 🔍 Get Category Schema (for preview/debugging)
   */
  getCategorySchema = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { code } = req.params;
      
      console.log(`🔍 Fetching schema for category: ${code}`);
      const schemaData = await this.schemaService.getCategorySchema(code);
      
      console.log(`✅ Schema loaded: ${schemaData.stats.totalAttributes} attributes`);
      
      res.json({
        success: true,
        data: schemaData,
        timestamp: Date.now()
      });
    } catch (error: any) {
      console.error(`❌ Failed to fetch schema for ${req.params.code}:`, error);
      
      if (error.message?.includes('not found')) {
        res.status(404).json({
          success: false,
          error: error.message,
          timestamp: Date.now()
        });
        return;
      }
      
      next(error);
    }
  };

  /**
   * 🔎 Search Categories
   */
  searchCategories = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { q, limit } = req.query;
      
      if (!q || typeof q !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Query parameter "q" is required',
          timestamp: Date.now()
        });
        return;
      }
      
      console.log(`🔎 Searching categories: "${q}"`);
      const results = await this.schemaService.searchCategories(q, limit ? parseInt(limit as string) : 20);
      
      console.log(`✅ Found ${results.length} categories`);
      
      res.json({
        success: true,
        data: results,
        count: results.length,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('❌ Search failed:', error);
      next(error);
    }
  };
}