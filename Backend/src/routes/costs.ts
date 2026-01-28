/**
 * Cost Tracking Routes
 * Endpoints for retrieving extraction costs and session summaries
 */

import { Router, Request, Response } from 'express';
import { sessionCostTracker } from '../services/sessionCostTracker';
import { prismaClient as prisma } from '../utils/prisma';

const router = Router();

/**
 * GET /api/user/costs/current
 * Get current session cost summary
 */
router.get('/current', async (req: Request, res: Response) => {
  try {
    const summary = sessionCostTracker.getCurrentSession();
    
    return res.json({
      success: true,
      data: summary
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/user/costs/images
 * Get all images with their costs in current session
 */
router.get('/images', async (req: Request, res: Response) => {
  try {
    const images = sessionCostTracker.getImages();
    
    return res.json({
      success: true,
      data: {
        totalImages: images.length,
        totalCost: images.reduce((sum, img) => sum + img.cost, 0),
        images: images.map(img => ({
          imageId: img.imageId,
          imageName: img.imageName,
          imageUrl: img.imageUrl,
          tokens: {
            input: img.inputTokens,
            output: img.outputTokens,
            total: img.totalTokens
          },
          cost: img.cost,
          model: img.model,
          extractedAt: img.extractedAt,
          extractionTimeMs: img.extractionTimeMs
        }))
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/user/costs/image/:imageId
 * Get details for a specific image extraction
 */
router.get('/image/:imageId', async (req: Request, res: Response) => {
  try {
    const { imageId } = req.params;
    const image = sessionCostTracker.getImageById(imageId);
    
    if (!image) {
      return res.status(404).json({
        success: false,
        error: 'Image not found'
      });
    }
    
    return res.json({
      success: true,
      data: image
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/user/costs/summary
 * Get formatted cost summary for display
 */
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const summary = sessionCostTracker.getCostSummaryForDisplay();
    
    return res.json({
      success: true,
      data: summary
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/user/costs/reset
 * Reset session and clear all tracked costs
 */
router.post('/reset', async (req: Request, res: Response) => {
  try {
    const oldSession = sessionCostTracker.getCurrentSession();
    sessionCostTracker.resetCurrentSession();
    
    return res.json({
      success: true,
      message: 'Session reset successfully',
      data: {
        imagesReset: oldSession.totalImages,
        costReset: oldSession.totalCost,
        newSessionId: sessionCostTracker.getCurrentSession().sessionId
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/user/costs/export
 * Export current session as JSON
 */
router.get('/export', async (req: Request, res: Response) => {
  try {
    const json = sessionCostTracker.exportSessionAsJSON();
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=cost-tracking-export.json');
    return res.send(json);
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/costs/all
 * [ADMIN ONLY] Get all extraction costs from database
 */
router.get('/admin/all', async (req: Request, res: Response) => {
  try {
    const extractions = await prisma.extractionJob.findMany({
      where: {
        status: 'COMPLETED'
      },
      select: {
        id: true,
        imageUrl: true,
        status: true,
        processingTimeMs: true,
        tokensUsed: true,
        costPrice: true,
        sellingPrice: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    const totalCost = extractions.reduce((sum, ext) => sum + (ext.costPrice?.toNumber() || 0), 0);

    return res.json({
      success: true,
      data: {
        totalExtractions: extractions.length,
        totalCost,
        averageCostPerExtraction: totalCost / extractions.length,
        extractions
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
