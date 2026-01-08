import {
  handleSearch,
  handleGetItem,
  handleGetCollections,
  handleSearchCollections,
  handleGetCollectionDetails,
  handleGetCollectionItems,
  handleGetSubcollections,
  handleSearchFulltext,
  handleGetItemAbstract
} from './apiHandlers';
import { UnifiedContentExtractor } from './unifiedContentExtractor';
import { SmartAnnotationExtractor } from './smartAnnotationExtractor';
import { MCPSettingsService } from './mcpSettingsService';
import { AIInstructionsManager } from './aiInstructionsManager';
import { getSemanticSearchService, SemanticSearchService } from './semantic';

export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

/**
 * 统一的MCP响应数据结构
 */
interface UnifiedMCPResponse {
  data: any;
  metadata: {
    extractedAt: string;
    toolName: string;
    responseType: 'search' | 'content' | 'annotation' | 'collection' | 'text' | 'object' | 'array';
    aiGuidelines?: any;
    [key: string]: any;
  };
  _dataIntegrity?: string;
  _instructions?: string;
}

/**
 * Apply global AI instructions and create unified response structure
 */
function applyGlobalAIInstructions(responseData: any, toolName: string): UnifiedMCPResponse {
  if (!responseData) {
    return createUnifiedResponse(null, 'object', toolName);
  }
  
  // 处理字符串响应（如format='text'时的get_content）
  if (typeof responseData === 'string') {
    return createUnifiedResponse(responseData, 'text', toolName);
  }
  
  // 处理数组响应（如某些collection列表）
  if (Array.isArray(responseData)) {
    return createUnifiedResponse(responseData, 'array', toolName, { count: responseData.length });
  }
  
  // 处理对象响应
  if (typeof responseData === 'object') {
    // 检查是否是SmartAnnotationExtractor或UnifiedContentExtractor的完整结构
    if (responseData.metadata && (responseData.data !== undefined || responseData.content !== undefined)) {
      // 已有完整结构，只需增强metadata并保护数据
      const enhanced = {
        ...responseData,
        metadata: AIInstructionsManager.enhanceMetadataWithAIGuidelines({
          ...responseData.metadata,
          toolName,
          responseType: determineResponseType(toolName),
          toolGuidance: getToolSpecificGuidance(toolName)
        })
      };
      return AIInstructionsManager.protectResponseData(enhanced);
    }
    
    // 否则包装为统一结构
    return createUnifiedResponse(responseData, 'object', toolName);
  }
  
  // 其他类型的响应（数字、布尔等）
  return createUnifiedResponse(responseData, typeof responseData as any, toolName);
}

/**
 * 创建统一的响应结构
 */
function createUnifiedResponse(
  data: any, 
  responseType: 'search' | 'content' | 'annotation' | 'collection' | 'text' | 'object' | 'array', 
  toolName: string,
  additionalMeta?: any
): UnifiedMCPResponse {
  const baseMetadata = {
    extractedAt: new Date().toISOString(),
    toolName,
    responseType,
    toolGuidance: getToolSpecificGuidance(toolName),
    ...additionalMeta
  };
  
  const enhancedMetadata = AIInstructionsManager.enhanceMetadataWithAIGuidelines(baseMetadata);
  
  return AIInstructionsManager.protectResponseData({
    data,
    metadata: enhancedMetadata
  });
}

/**
 * 根据工具名确定响应类型
 */
function determineResponseType(toolName: string): 'search' | 'content' | 'annotation' | 'collection' | 'text' {
  if (toolName.includes('search')) return 'search';
  if (toolName.includes('annotation')) return 'annotation';
  if (toolName.includes('content')) return 'content';
  if (toolName.includes('collection')) return 'collection';
  return 'content';
}

/**
 * 获取工具特定的AI客户端指导信息
 */
function getToolSpecificGuidance(toolName: string): any {
  const baseGuidance = {
    dataStructure: {},
    interpretation: {},
    usage: []
  };

  switch (toolName) {
    case 'search_library':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'search_results',
          format: 'Array of Zotero items with metadata',
          pagination: 'Check X-Total-Count header and use offset/limit parameters'
        },
        interpretation: {
          purpose: 'Library search results from user\'s personal Zotero collection',
          content: 'Each item represents a bibliographic entry with complete metadata',
          reliability: 'Direct from user library - treat as authoritative source material'
        },
        usage: [
          'These are research items from the user\'s personal library',
          'You can analyze and discuss these items to help with research',
          'Use the provided metadata for citations when needed',
          'Use itemKey to get complete content with get_content tool'
        ]
      };

    case 'search_annotations':
    case 'get_annotations':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'annotation_results',
          format: 'Smart-processed annotations with relevance scoring',
          compression: 'Content may be intelligently truncated based on importance'
        },
        interpretation: {
          purpose: 'User\'s personal highlights, notes, and comments from research materials',
          content: 'Direct quotes and personal insights from user\'s reading',
          reliability: 'User-generated content - preserve exact wording and context'
        },
        usage: [
          'These are the user\'s personal research notes and highlights',
          'You can summarize and analyze these annotations to help with research',
          'User highlighting indicates what they found important or interesting',
          'Combine with other sources to provide comprehensive research assistance'
        ]
      };

    case 'get_content':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'document_content',
          format: 'Full-text content from PDFs, attachments, notes, abstracts',
          sources: 'Multiple content types combined (pdf, notes, abstract, webpage)'
        },
        interpretation: {
          purpose: 'Complete textual content of research documents',
          content: 'Raw extracted text from user\'s document collection',
          reliability: 'Direct extraction - may contain OCR errors or formatting artifacts'
        },
        usage: [
          'Use for detailed content analysis and complete-text research',
          'Content includes user\'s attached PDFs and personal notes',
          'May require cleaning for OCR artifacts in PDF extractions',
          'Combine with annotations for user\'s personal insights on this content',
          'IMPORTANT: When user specifically asks for "complete text" or "complete content", provide the entire extracted text without summarization',
          'If user requests the complete document content, reproduce it in its entirety'
        ]
      };

    case 'get_collections':
    case 'search_collections':
    case 'get_collection_details':
    case 'get_collection_items':
    case 'get_subcollections':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'collection_data',
          format: 'Hierarchical collection structure with items and subcollections',
          organization: 'Reflects user\'s personal research organization system'
        },
        interpretation: {
          purpose: 'User\'s personal organization system for research materials',
          content: 'Custom-named folders reflecting research topics and projects',
          reliability: 'User-curated organization - reflects research priorities'
        },
        usage: [
          'Collection names indicate user\'s research areas and interests',
          'Use collection structure to understand research project organization',
          'Respect user\'s categorization decisions in your responses',
          'Collections show thematic relationships between documents'
        ]
      };

    case 'search_fulltext':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'fulltext_search',
          format: 'Full-text search results with content snippets',
          relevance: 'Results ranked by text matching and relevance'
        },
        interpretation: {
          purpose: 'Deep content search across all document texts',
          content: 'Matching text passages from user\'s entire document collection',
          reliability: 'Search-based - results depend on query accuracy'
        },
        usage: [
          'Use for finding specific concepts across entire research collection',
          'Results show where user has relevant materials on specific topics',
          'Combine with other tools for complete context',
          'Good for discovering connections between different documents',
          'When user asks for complete content from search results, use get_content with the itemKey to retrieve complete text'
        ]
      };

    case 'get_item_details':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'item_metadata',
          format: 'Complete bibliographic metadata for single item',
          completeness: 'Full citation information and item relationships'
        },
        interpretation: {
          purpose: 'Detailed metadata for specific research item',
          content: 'Publication details, authors, dates, identifiers, relationships',
          reliability: 'Curated metadata - suitable for citations and references'
        },
        usage: [
          'Use for generating proper citations and references',
          'Contains all bibliographic data needed for academic writing',
          'Use itemKey to access complete content via get_content',
          'Check for related items and collections for broader context'
        ]
      };

    case 'get_item_abstract':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'abstract_content',
          format: 'Academic abstract or summary text',
          source: 'Publisher-provided or user-entered abstract'
        },
        interpretation: {
          purpose: 'Summary of research paper or document main points',
          content: 'Concise overview of research objectives, methods, results',
          reliability: 'Authoritative summary - typically from original publication'
        },
        usage: [
          'Use for quick understanding of paper\'s main contributions',
          'Suitable for literature reviews and research summaries',
          'Abstract represents author\'s own summary of their work',
          'Combine with complete content and annotations for complete understanding'
        ]
      };

    case 'semantic_search':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'semantic_search_results',
          format: 'AI-powered similarity search results with relevance scores',
          ranking: 'Results ranked by semantic similarity to query'
        },
        interpretation: {
          purpose: 'Find conceptually related content beyond keyword matching',
          content: 'Semantically similar documents, annotations, and passages',
          reliability: 'AI-powered - results based on meaning similarity'
        },
        usage: [
          'Use for concept-based research exploration',
          'Find related papers even without exact keyword matches',
          'Discover thematic connections across research materials',
          'Combine with keyword search for comprehensive results'
        ]
      };

    case 'find_similar':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'similar_items',
          format: 'Items semantically similar to the reference item',
          ranking: 'Ranked by embedding similarity'
        },
        interpretation: {
          purpose: 'Discover related research materials',
          content: 'Documents with similar concepts, themes, or topics',
          reliability: 'Based on semantic analysis of content'
        },
        usage: [
          'Use to expand research from a known relevant paper',
          'Find related work that might be missed by citation analysis',
          'Discover thematic clusters in the library'
        ]
      };

    case 'build_semantic_index':
    case 'semantic_status':
    case 'pause_semantic_index':
    case 'resume_semantic_index':
    case 'abort_semantic_index':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'index_status',
          format: 'Index build progress and statistics'
        },
        interpretation: {
          purpose: 'Manage semantic search index',
          content: 'Index status, progress, and statistics'
        },
        usage: [
          'Check if semantic search is available',
          'Monitor index building progress',
          'Verify index coverage of library',
          'Use pause_semantic_index to temporarily stop indexing',
          'Use resume_semantic_index to continue from where it stopped',
          'Use abort_semantic_index to stop indexing completely (progress is saved)'
        ]
      };

    case 'configure_embedding':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'embedding_config',
          format: 'API configuration and connection test results'
        },
        interpretation: {
          purpose: 'Configure embedding API for semantic search',
          content: 'API settings, model info, and connection status'
        },
        usage: [
          'Set up OpenAI-compatible embedding API',
          'Configure custom API endpoints',
          'Test API connectivity'
        ]
      };

    case 'fulltext_database':
      return {
        ...baseGuidance,
        dataStructure: {
          type: 'fulltext_database',
          format: 'Extracted PDF text content database',
          actions: 'extract, list, search, get, stats, delete, pause, resume, abort, status'
        },
        interpretation: {
          purpose: 'Access and manage persistent full-text content database',
          content: 'Extracted PDF text stored independently of vector index',
          reliability: 'Cached extraction - faster than re-extracting from Zotero'
        },
        usage: [
          'Use extract to batch extract PDF content (by itemKeys, collectionKey, or all items)',
          'Use stats to check database size and item count',
          'Use list to see which items have cached content',
          'Use search to find items containing specific text',
          'Use get to retrieve full content for specific items',
          'Use delete to remove specific items from cache',
          'Use status to check extraction progress',
          'Use pause to temporarily stop extraction',
          'Use resume to continue paused extraction',
          'Use abort to stop extraction (progress is saved)',
          'Content persists across vector index rebuilds',
          'Extract is async - use status to monitor progress'
        ]
      };

    default:
      return baseGuidance;
  }
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  sessionId?: string;
}

export interface MCPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

/**
 * Streamable HTTP-based MCP Server integrated into Zotero Plugin
 * 
 * This provides a complete MCP (Model Context Protocol) server implementation
 * that runs directly within the Zotero plugin. AI clients can connect using
 * streamable HTTP requests for real-time bidirectional communication.
 * 
 * Architecture: AI Client (streamable HTTP) ↔ Zotero Plugin (integrated MCP server)
 */
// Full-text extraction progress tracking
interface ExtractionProgress {
  total: number;
  processed: number;
  extracted: number;
  failed: number;
  currentItem?: string;
  status: 'idle' | 'extracting' | 'paused' | 'completed' | 'aborted' | 'error';
  startTime?: number;
  error?: string;
}

export class StreamableMCPServer {
  private isInitialized: boolean = false;
  private serverInfo = {
    name: 'zotero-integrated-mcp',
    version: '1.1.0',
  };
  private clientSessions: Map<string, { initTime: Date; lastActivity: Date; clientInfo?: any }> = new Map();

  // Full-text extraction control
  private extractionProgress: ExtractionProgress = {
    total: 0,
    processed: 0,
    extracted: 0,
    failed: 0,
    status: 'idle'
  };
  private _extractionPaused = false;
  private _extractionAborted = false;
  private _extractionPauseResolve: (() => void) | null = null;

  constructor() {
    // No initialization needed - using direct function calls
  }

  /**
   * Handle incoming MCP requests and return HTTP response
   */
  async handleMCPRequest(requestBody: string): Promise<{ status: number; statusText: string; headers: any; body: string }> {
    try {
      const request = JSON.parse(requestBody) as MCPRequest;
      ztoolkit.log(`[StreamableMCP] Received: ${request.method}`);

      const response = await this.processRequest(request);
      
      return {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(response)
      };
      
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Error handling request: ${error}`);
      
      const errorResponse: MCPResponse = {
        jsonrpc: '2.0',
        id: 'unknown',
        error: {
          code: -32700,
          message: 'Parse error'
        }
      };
      
      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(errorResponse)
      };
    }
  }

  /**
   * Process individual MCP requests
   */
  private async processRequest(request: MCPRequest): Promise<MCPResponse> {
    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(request);

        case 'initialized':
          this.isInitialized = true;
          ztoolkit.log('[StreamableMCP] Client initialized');
          return this.createResponse(request.id, { success: true });

        case 'tools/list':
          return this.handleToolsList(request);

        case 'tools/call':
          return await this.handleToolCall(request);

        case 'resources/list':
          return this.handleResourcesList(request);

        case 'prompts/list':
          return this.handlePromptsList(request);

        case 'ping':
          return this.handlePing(request);

        default:
          return this.createError(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Error processing ${request.method}: ${error}`);
      return this.createError(request.id, -32603, 'Internal error');
    }
  }

  private handleInitialize(request: MCPRequest): MCPResponse {
    // Extract client info from initialize request
    const clientInfo = request.params?.clientInfo || {};
    const sessionId = this.generateSessionId();
    
    // Store session info
    this.clientSessions.set(sessionId, {
      initTime: new Date(),
      lastActivity: new Date(),
      clientInfo
    });
    
    ztoolkit.log(`[StreamableMCP] Client initialized with session: ${sessionId}, client: ${clientInfo.name || 'unknown'}`);
    
    // Create standard MCP initialize response (no custom fields)
    return this.createResponse(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {
          listChanged: true,
        },
        logging: {},
        prompts: {},
        resources: {},
      },
      serverInfo: this.serverInfo,
    });
  }

  private generateSessionId(): string {
    return 'mcp-session-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 9);
  }

  private handleResourcesList(request: MCPRequest): MCPResponse {
    // Return empty resources list - we don't currently support resources
    return this.createResponse(request.id, { resources: [] });
  }

  private handlePromptsList(request: MCPRequest): MCPResponse {
    // Return empty prompts list - we don't currently support prompts
    return this.createResponse(request.id, { prompts: [] });
  }

  private handlePing(request: MCPRequest): MCPResponse {
    // Standard MCP ping response - just return empty result
    return this.createResponse(request.id, {});
  }


  private handleToolsList(request: MCPRequest): MCPResponse {
    const tools = [
      {
        name: 'search_library',
        description: 'Search the Zotero library with advanced parameters, boolean operators, relevance scoring, pagination, and intelligent mode control.',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'General search query' },
            title: { type: 'string', description: 'Title search' },
            titleOperator: { 
              type: 'string', 
              enum: ['contains', 'exact', 'startsWith', 'endsWith', 'regex'],
              description: 'Title search operator' 
            },
            yearRange: { type: 'string', description: 'Year range (e.g., "2020-2023")' },
            fulltext: { type: 'string', description: 'Full-text search in attachments and notes' },
            fulltextMode: { 
              type: 'string', 
              enum: ['attachment', 'note', 'both'],
              description: 'Full-text search mode: attachment (PDFs only), note (notes only), both (default)' 
            },
            fulltextOperator: { 
              type: 'string', 
              enum: ['contains', 'exact', 'regex'],
              description: 'Full-text search operator (default: contains)' 
            },
            mode: {
              type: 'string',
              enum: ['minimal', 'preview', 'standard', 'complete'],
              description: 'Processing mode: minimal (30 results), preview (100), standard (adaptive), complete (500+). Uses user default if not specified.'
            },
            relevanceScoring: { type: 'boolean', description: 'Enable relevance scoring' },
            sort: { 
              type: 'string', 
              enum: ['relevance', 'date', 'title', 'year'],
              description: 'Sort order' 
            },
            limit: { type: 'number', description: 'Maximum results to return (overrides mode default)' },
            offset: { type: 'number', description: 'Pagination offset' },
          },
        },
      },
      {
        name: 'search_annotations',
        description: 'Search and filter annotations by query, colors, or tags. Supports intelligent ranking and content management.',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search query (optional if colors or tags provided)' },
            itemKeys: {
              type: 'array',
              items: { type: 'string' },
              description: 'Limit search to specific items'
            },
            types: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['note', 'highlight', 'annotation', 'ink', 'text', 'image']
              },
              description: 'Types of annotations to search'
            },
            colors: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by colors. Use hex codes (#ffd400) or names (yellow, red, green, blue, purple, orange). Common mappings: yellow=question, red=error/important, green=agree, blue=info, purple=definition'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by tags attached to annotations'
            },
            mode: {
              type: 'string',
              enum: ['standard', 'preview', 'complete', 'minimal'],
              description: 'Content processing mode (uses user setting default if not specified)'
            },
            maxTokens: {
              type: 'number',
              description: 'Token budget (uses user setting default if not specified)'
            },
            minRelevance: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              default: 0.1,
              description: 'Minimum relevance threshold (only applies when q is provided)'
            },
            limit: { type: 'number', default: 15, description: 'Maximum results' },
            offset: { type: 'number', default: 0, description: 'Pagination offset' }
          },
          description: 'Requires at least one of: q (query), colors, or tags'
        },
      },
      {
        name: 'get_item_details',
        description: 'Get detailed information for a specific item with intelligent mode control (metadata, abstract, attachments, notes, tags but not fulltext content)',
        inputSchema: {
          type: 'object',
          properties: {
            itemKey: { type: 'string', description: 'Unique item key' },
            mode: {
              type: 'string',
              enum: ['minimal', 'preview', 'standard', 'complete'],
              description: 'Processing mode: minimal (basic info), preview (key fields), standard (comprehensive), complete (all fields). Uses user default if not specified.'
            },
          },
          required: ['itemKey'],
        },
      },
      {
        name: 'get_annotations',
        description: 'Get annotations and notes with intelligent content management, color/tag filtering (PDF annotations, highlights, notes)',
        inputSchema: {
          type: 'object',
          properties: {
            itemKey: { type: 'string', description: 'Get all annotations for this item' },
            annotationId: { type: 'string', description: 'Get specific annotation by ID' },
            annotationIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Get multiple annotations by IDs'
            },
            types: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['note', 'highlight', 'annotation', 'ink', 'text', 'image']
              },
              default: ['note', 'highlight', 'annotation'],
              description: 'Types of annotations to include'
            },
            colors: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by colors. Use hex codes (#ffd400) or names (yellow, red, green, blue, purple, orange). Example: ["yellow", "red"] to get question and error annotations'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by tags attached to annotations'
            },
            mode: {
              type: 'string',
              enum: ['standard', 'preview', 'complete', 'minimal'],
              description: 'Content processing mode (uses user setting default if not specified)'
            },
            maxTokens: {
              type: 'number',
              description: 'Token budget (uses user setting default if not specified)'
            },
            limit: { type: 'number', default: 20, description: 'Maximum results' },
            offset: { type: 'number', default: 0, description: 'Pagination offset' }
          },
          description: 'Requires either itemKey, annotationId, or annotationIds parameter'
        },
      },
      {
        name: 'get_content',
        description: 'Unified content extraction tool: get PDF, attachments, notes, abstract etc. from items or specific attachments with intelligent processing',
        inputSchema: {
          type: 'object',
          properties: {
            itemKey: { type: 'string', description: 'Item key to get all content from this item' },
            attachmentKey: { type: 'string', description: 'Attachment key to get content from specific attachment' },
            mode: {
              type: 'string',
              enum: ['minimal', 'preview', 'standard', 'complete'],
              description: 'Content processing mode: minimal (500 chars, fastest), preview (1.5K chars, quick scan), standard (3K chars, balanced), complete (unlimited, complete content). Uses user default if not specified.'
            },
            include: {
              type: 'object',
              properties: {
                pdf: { type: 'boolean', default: true, description: 'Include PDF attachments content' },
                attachments: { type: 'boolean', default: true, description: 'Include other attachments content' },
                notes: { type: 'boolean', default: true, description: 'Include notes content' },
                abstract: { type: 'boolean', default: true, description: 'Include abstract' },
                webpage: { type: 'boolean', default: false, description: 'Include webpage snapshots (auto-enabled in standard/complete modes)' }
              },
              description: 'Content types to include (only applies to itemKey)'
            },
            contentControl: {
              type: 'object',
              properties: {
                preserveOriginal: { type: 'boolean', default: true, description: 'Always preserve original text structure when processing' },
                allowExtended: { type: 'boolean', default: false, description: 'Allow retrieving more content than mode default when important' },
                expandIfImportant: { type: 'boolean', default: false, description: 'Expand content length for high-importance content' },
                maxContentLength: { type: 'number', description: 'Override maximum content length for this request' },
                prioritizeCompleteness: { type: 'boolean', default: false, description: 'Prioritize complete sentences/paragraphs over strict length limits' },
                standardExpansion: {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean', default: false, description: 'Enable standard content expansion' },
                    trigger: { 
                      type: 'string', 
                      enum: ['high_importance', 'user_query', 'context_needed'],
                      default: 'high_importance',
                      description: 'Trigger condition for standard expansion'
                    },
                    maxExpansionRatio: { type: 'number', default: 2.0, minimum: 1.0, maximum: 10.0, description: 'Maximum expansion ratio (1.0 = no expansion, 2.0 = double)' }
                  },
                  description: 'Smart expansion configuration'
                }
              },
              description: 'Advanced content control parameters to override mode defaults'
            },
            format: { 
              type: 'string', 
              enum: ['json', 'text'],
              default: 'json',
              description: 'Output format: json (structured with metadata) or text (plain text)' 
            }
          },
          description: 'Requires either itemKey or attachmentKey parameter'
        },
      },
      {
        name: 'get_collections',
        description: 'Get list of all collections in the library with intelligent mode control',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['minimal', 'preview', 'standard', 'complete'],
              description: 'Processing mode: minimal (20 collections), preview (50), standard (100), complete (500+). Uses user default if not specified.'
            },
            limit: { type: 'number', description: 'Maximum results to return (overrides mode default)' },
            offset: { type: 'number', description: 'Pagination offset' },
          },
        },
      },
      {
        name: 'search_collections',
        description: 'Search collections by name',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Collection name search query' },
            limit: { type: 'number', description: 'Maximum results to return' },
          },
        },
      },
      {
        name: 'get_collection_details',
        description: 'Get detailed information about a specific collection',
        inputSchema: {
          type: 'object',
          properties: {
            collectionKey: { type: 'string', description: 'Collection key' },
          },
          required: ['collectionKey'],
        },
      },
      {
        name: 'get_collection_items',
        description: 'Get items in a specific collection',
        inputSchema: {
          type: 'object',
          properties: {
            collectionKey: { type: 'string', description: 'Collection key' },
            limit: { type: 'number', description: 'Maximum results to return' },
            offset: { type: 'number', description: 'Pagination offset' },
          },
          required: ['collectionKey'],
        },
      },
      {
        name: 'get_subcollections',
        description: 'Get subcollections (child collections) of a specific collection',
        inputSchema: {
          type: 'object',
          properties: {
            collectionKey: { type: 'string', description: 'Parent collection key' },
            limit: { type: 'number', description: 'Maximum results to return (default: 100)' },
            offset: { type: 'number', description: 'Pagination offset (default: 0)' },
            recursive: { 
              type: 'boolean', 
              description: 'Include subcollection count for each subcollection (default: false)' 
            },
          },
          required: ['collectionKey'],
        },
      },
      {
        name: 'search_fulltext',
        description: 'Search within fulltext content of items with context, relevance scoring, and intelligent mode control',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search query' },
            itemKeys: { 
              type: 'array', 
              items: { type: 'string' },
              description: 'Limit search to specific items (optional)' 
            },
            mode: {
              type: 'string',
              enum: ['minimal', 'preview', 'standard', 'complete'],
              description: 'Processing mode: minimal (100 context), preview (200), standard (adaptive), complete (400+). Uses user default if not specified.'
            },
            contextLength: { type: 'number', description: 'Context length around matches (overrides mode default)' },
            maxResults: { type: 'number', description: 'Maximum results to return (overrides mode default)' },
            caseSensitive: { type: 'boolean', description: 'Case sensitive search (default: false)' },
          },
          required: ['q'],
        },
      },
      {
        name: 'get_item_abstract',
        description: 'Get the abstract/summary of a specific item',
        inputSchema: {
          type: 'object',
          properties: {
            itemKey: { type: 'string', description: 'Item key' },
            format: {
              type: 'string',
              enum: ['json', 'text'],
              description: 'Response format (default: json)'
            },
          },
          required: ['itemKey'],
        },
      },
      // Semantic Search Tools
      {
        name: 'semantic_search',
        description: 'AI-powered semantic search using embeddings. Finds conceptually related content even without exact keyword matches. Supports hybrid search combining semantic and keyword matching.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural language search query (e.g., "machine learning in healthcare")'
            },
            topK: {
              type: 'number',
              description: 'Number of results to return (default: 10)'
            },
            minScore: {
              type: 'number',
              description: 'Minimum similarity score 0-1 (default: 0.3)'
            },
            language: {
              type: 'string',
              enum: ['zh', 'en', 'all'],
              description: 'Filter by language (default: all)'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'find_similar',
        description: 'Find items semantically similar to a given item. Uses AI embeddings to discover related research materials.',
        inputSchema: {
          type: 'object',
          properties: {
            itemKey: {
              type: 'string',
              description: 'The item key to find similar items for'
            },
            topK: {
              type: 'number',
              description: 'Number of similar items to return (default: 5)'
            },
            minScore: {
              type: 'number',
              description: 'Minimum similarity score 0-1 (default: 0.5)'
            }
          },
          required: ['itemKey']
        }
      },
      {
        name: 'build_semantic_index',
        description: 'Start building/updating the semantic search index (async). Returns immediately after starting. Use semantic_status to check progress, pause_semantic_index/resume_semantic_index to control, abort_semantic_index to stop.',
        inputSchema: {
          type: 'object',
          properties: {
            rebuild: {
              type: 'boolean',
              description: 'Rebuild entire index (default: false, only indexes new/changed items)'
            },
            itemKeys: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific items to index (optional, indexes all if not provided)'
            }
          }
        }
      },
      {
        name: 'semantic_status',
        description: 'Get the status of the semantic search service including index statistics and progress.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'configure_embedding',
        description: 'Configure the embedding API for semantic search. Supports OpenAI-compatible APIs.',
        inputSchema: {
          type: 'object',
          properties: {
            apiBase: {
              type: 'string',
              description: 'API base URL (e.g., https://api.openai.com/v1 or custom endpoint)'
            },
            apiKey: {
              type: 'string',
              description: 'API key for authentication'
            },
            model: {
              type: 'string',
              description: 'Model name (e.g., text-embedding-3-small, text-embedding-ada-002)'
            },
            dimensions: {
              type: 'number',
              description: 'Output embedding dimensions (optional, 512 default)'
            },
            test: {
              type: 'boolean',
              description: 'Test the connection after configuring (default: true)'
            }
          }
        }
      },
      {
        name: 'pause_semantic_index',
        description: 'Pause the currently running semantic indexing process. Can be resumed later.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'resume_semantic_index',
        description: 'Resume a paused semantic indexing process.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'abort_semantic_index',
        description: 'Abort the semantic indexing process. Progress will be saved, but indexing will stop.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      // Full-text Database Tool
      {
        name: 'fulltext_database',
        description: 'Access the full-text content database. Can extract PDF content, list cached items, search within cached content, or get full content. Extraction supports pause/resume/abort. This is a persistent database of extracted PDF text.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['extract', 'list', 'search', 'get', 'stats', 'delete', 'pause', 'resume', 'abort', 'status'],
              description: 'Action: extract (extract PDF content), list (show cached items), search (search within content), get (get full content), stats (database statistics), delete (remove cached content), pause (pause extraction), resume (resume extraction), abort (stop extraction), status (get extraction progress)'
            },
            query: {
              type: 'string',
              description: 'Search query (required for search action)'
            },
            itemKeys: {
              type: 'array',
              items: { type: 'string' },
              description: 'Item keys for extract/get/delete actions. If not provided for extract, extracts all items.'
            },
            collectionKey: {
              type: 'string',
              description: 'Collection key to extract items from (optional for extract action)'
            },
            limit: {
              type: 'number',
              description: 'Maximum results to return (default: 20 for list/search), or max items to extract'
            },
            caseSensitive: {
              type: 'boolean',
              description: 'Case sensitive search (default: false)'
            },
            skipExisting: {
              type: 'boolean',
              description: 'Skip items already in cache (default: true for extract action)'
            }
          },
          required: ['action']
        }
      }
    ];

    return this.createResponse(request.id, { tools });
  }

  private async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params;
    
    try {
      let result;
      
      switch (name) {
        case 'search_library':
          result = await this.callSearchLibrary(args);
          break;

        case 'search_annotations':
          // q is optional when colors or tags filters are provided
          if (!args?.q && !args?.colors && !args?.tags) {
            throw new Error('Either q (query), colors, or tags filter is required');
          }
          result = await this.callSearchAnnotations(args);
          break;

        case 'get_item_details':
          if (!args?.itemKey) {
            throw new Error('itemKey is required');
          }
          result = await this.callGetItemDetails(args);
          break;

        case 'get_annotations':
          if (!args?.itemKey && !args?.annotationId && !args?.annotationIds) {
            throw new Error('Either itemKey, annotationId, or annotationIds is required');
          }
          result = await this.callGetAnnotations(args);
          break;

        case 'get_content':
          if (!args?.itemKey && !args?.attachmentKey) {
            throw new Error('Either itemKey or attachmentKey is required');
          }
          result = await this.callGetContent(args);
          break;

        case 'get_collections':
          result = await this.callGetCollections(args);
          break;

        case 'search_collections':
          result = await this.callSearchCollections(args);
          break;

        case 'get_collection_details':
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          result = await this.callGetCollectionDetails(args.collectionKey);
          break;

        case 'get_collection_items':
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          result = await this.callGetCollectionItems(args);
          break;

        case 'get_subcollections':
          if (!args?.collectionKey) {
            throw new Error('collectionKey is required');
          }
          result = await this.callGetSubcollections(args);
          break;

        case 'search_fulltext':
          if (!args?.q) {
            throw new Error('q (query) is required');
          }
          result = await this.callSearchFulltext(args);
          break;

        case 'get_item_abstract':
          if (!args?.itemKey) {
            throw new Error('itemKey is required');
          }
          result = await this.callGetItemAbstract(args);
          break;

        // Semantic Search Tools
        case 'semantic_search':
          if (!args?.query) {
            throw new Error('query is required');
          }
          result = await this.callSemanticSearch(args);
          break;

        case 'find_similar':
          if (!args?.itemKey) {
            throw new Error('itemKey is required');
          }
          result = await this.callFindSimilar(args);
          break;

        case 'build_semantic_index':
          result = await this.callBuildSemanticIndex(args);
          break;

        case 'semantic_status':
          result = await this.callSemanticStatus();
          break;

        case 'configure_embedding':
          result = await this.callConfigureEmbedding(args);
          break;

        case 'pause_semantic_index':
          result = await this.callPauseSemanticIndex();
          break;

        case 'resume_semantic_index':
          result = await this.callResumeSemanticIndex();
          break;

        case 'abort_semantic_index':
          result = await this.callAbortSemanticIndex();
          break;

        case 'fulltext_database':
          if (!args?.action) {
            throw new Error('action is required');
          }
          result = await this.callFulltextDatabase(args);
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      // Wrap result in MCP content format with proper text type
      return this.createResponse(request.id, { 
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      });

    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Tool call error for ${name}: ${error}`);
      return this.createError(request.id, -32603, 
        `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async callSearchLibrary(args: any): Promise<any> {
    // Apply mode-based defaults before creating search params
    const effectiveMode = args.mode || MCPSettingsService.get('content.mode');
    const modeConfig = this.getSearchModeConfiguration(effectiveMode);
    
    // Apply mode defaults if not explicitly provided
    const processedArgs = {
      ...args,
      limit: args.limit || modeConfig.limit
    };
    
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(processedArgs)) {
      if (value !== undefined && value !== null) {
        if (key !== 'mode') { // Don't pass mode to API
          searchParams.append(key, String(value));
        }
      }
    }
    
    const response = await handleSearch(searchParams);
    let result = response.body ? JSON.parse(response.body) : response;
    
    // Add mode information to metadata
    if (result && typeof result === 'object') {
      result.metadata = {
        ...result.metadata,
        mode: effectiveMode,
        appliedModeConfig: modeConfig
      };
      
      // Remove any unwanted content array if it's empty
      if (Array.isArray(result.content) && result.content.length === 0) {
        delete result.content;
      }
    }
    
    return applyGlobalAIInstructions(result, 'search_library');
  }

  private async callSearchAnnotations(args: any): Promise<any> {
    const extractor = new SmartAnnotationExtractor();
    const { q, ...options } = args;
    const result = await extractor.searchAnnotations(q, options);
    return applyGlobalAIInstructions(result, 'search_annotations');
  }

  private async callGetItemDetails(args: any): Promise<any> {
    const { itemKey, mode } = args;
    
    // Import the specific handler for item details
    const { handleGetItem } = await import('./apiHandlers');
    
    // Get effective mode
    const effectiveMode = mode || MCPSettingsService.get('content.mode');
    
    // Create query params with mode-based field selection
    const queryParams = new URLSearchParams();
    if (effectiveMode !== 'complete') {
      // Apply field filtering based on mode (this could be enhanced in apiHandlers)
      const modeConfig = this.getItemDetailsModeConfiguration(effectiveMode);
      if (modeConfig.fields) {
        queryParams.append('fields', modeConfig.fields.join(','));
      }
    }
    
    // Call the dedicated item details handler
    const response = await handleGetItem({ 1: itemKey }, queryParams);
    let result = response.body ? JSON.parse(response.body) : response;
    
    // Add mode information to metadata
    if (result && typeof result === 'object') {
      result.metadata = {
        ...result.metadata,
        mode: effectiveMode,
        appliedModeConfig: this.getItemDetailsModeConfiguration(effectiveMode)
      };
    }
    
    return applyGlobalAIInstructions(result, 'get_item_details');
  }

  private async callGetAnnotations(args: any): Promise<any> {
    const extractor = new SmartAnnotationExtractor();
    const result = await extractor.getAnnotations(args);
    return applyGlobalAIInstructions(result, 'get_annotations');
  }

  private async callGetContent(args: any): Promise<any> {
    const { itemKey, attachmentKey, include, format, mode, contentControl } = args;
    const extractor = new UnifiedContentExtractor();
    
    try {
      let result;
      
      if (itemKey) {
        // Get content from item with unified mode control and content control parameters
        result = await extractor.getItemContent(itemKey, include || {}, mode, contentControl);
      } else if (attachmentKey) {
        // Get content from specific attachment with unified mode control and content control parameters
        result = await extractor.getAttachmentContent(attachmentKey, mode, contentControl);
      } else {
        throw new Error('Either itemKey or attachmentKey must be provided');
      }
      
      // Apply format conversion if requested
      if (format === 'text' && itemKey) {
        return extractor.convertToText(result);
      } else if (format === 'text' && attachmentKey) {
        return result.content || '';
      }
      
      return applyGlobalAIInstructions(result, 'get_content');
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Error in callGetContent: ${error}`, 'error');
      throw error;
    }
  }

  private async callGetCollections(args: any): Promise<any> {
    // Apply mode-based defaults before creating search params
    const effectiveMode = args.mode || MCPSettingsService.get('content.mode');
    const modeConfig = this.getCollectionModeConfiguration(effectiveMode);
    
    // Apply mode defaults if not explicitly provided
    const processedArgs = {
      ...args,
      limit: args.limit || modeConfig.limit
    };
    
    const collectionParams = new URLSearchParams();
    for (const [key, value] of Object.entries(processedArgs)) {
      if (value !== undefined && value !== null) {
        if (key !== 'mode') { // Don't pass mode to API
          collectionParams.append(key, String(value));
        }
      }
    }
    
    const response = await handleGetCollections(collectionParams);
    let result = response.body ? JSON.parse(response.body) : response;
    
    // Add mode information to metadata
    if (result && typeof result === 'object') {
      result.metadata = {
        ...result.metadata,
        mode: effectiveMode,
        appliedModeConfig: modeConfig
      };
    }
    
    return applyGlobalAIInstructions(result, 'get_collections');
  }

  private async callSearchCollections(args: any): Promise<any> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(args || {})) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const response = await handleSearchCollections(searchParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return applyGlobalAIInstructions(result, 'search_collections');
  }

  private async callGetCollectionDetails(collectionKey: string): Promise<any> {
    const response = await handleGetCollectionDetails({ 1: collectionKey }, new URLSearchParams());
    const result = response.body ? JSON.parse(response.body) : response;
    return applyGlobalAIInstructions(result, 'get_collection_details');
  }

  private async callGetCollectionItems(args: any): Promise<any> {
    const { collectionKey, ...otherArgs } = args;
    const itemParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        itemParams.append(key, String(value));
      }
    }
    const response = await handleGetCollectionItems({ 1: collectionKey }, itemParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return applyGlobalAIInstructions(result, 'get_collection_items');
  }

  private async callGetSubcollections(args: any): Promise<any> {
    const { collectionKey, ...otherArgs } = args;
    const subcollectionParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        subcollectionParams.append(key, String(value));
      }
    }
    const response = await handleGetSubcollections({ 1: collectionKey }, subcollectionParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return applyGlobalAIInstructions(result, 'get_subcollections');
  }


  private async callSearchFulltext(args: any): Promise<any> {
    // Apply mode-based defaults before creating search params
    const effectiveMode = args.mode || MCPSettingsService.get('content.mode');
    const modeConfig = this.getFulltextModeConfiguration(effectiveMode);
    
    // Apply mode defaults if not explicitly provided
    const processedArgs = {
      ...args,
      contextLength: args.contextLength || modeConfig.contextLength,
      maxResults: args.maxResults || modeConfig.maxResults
    };
    
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(processedArgs)) {
      if (value !== undefined && value !== null) {
        if (key === 'itemKeys' && Array.isArray(value)) {
          searchParams.append(key, value.join(','));
        } else if (key !== 'mode') { // Don't pass mode to API
          searchParams.append(key, String(value));
        }
      }
    }
    
    const response = await handleSearchFulltext(searchParams);
    let result = response.body ? JSON.parse(response.body) : response;
    
    // Add mode information to metadata
    if (result && typeof result === 'object') {
      result.metadata = {
        ...result.metadata,
        mode: effectiveMode,
        appliedModeConfig: modeConfig
      };
    }
    
    return applyGlobalAIInstructions(result, 'search_fulltext');
  }

  private async callGetItemAbstract(args: any): Promise<any> {
    const { itemKey, ...otherArgs } = args;
    const abstractParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        abstractParams.append(key, String(value));
      }
    }
    const response = await handleGetItemAbstract({ 1: itemKey }, abstractParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return applyGlobalAIInstructions(result, 'get_item_abstract');
  }

  // ============ Semantic Search Methods ============

  private async callSemanticSearch(args: any): Promise<any> {
    try {
      const semanticService = getSemanticSearchService();
      await semanticService.initialize();

      const results = await semanticService.search(args.query, {
        topK: args.topK,
        minScore: args.minScore,
        language: args.language
      });

      const response = {
        mode: 'semantic',
        query: args.query,
        data: results,
        metadata: {
          extractedAt: new Date().toISOString(),
          searchMode: 'semantic',
          resultCount: results.length,
          fallbackMode: semanticService.getIndexProgress().status === 'idle'
            ? (await semanticService.getStats()).serviceStatus.fallbackMode
            : false
        }
      };

      return applyGlobalAIInstructions(response, 'semantic_search');
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Semantic search error: ${error}`, 'error');
      throw error;
    }
  }

  private async callFindSimilar(args: any): Promise<any> {
    try {
      const semanticService = getSemanticSearchService();
      await semanticService.initialize();

      const results = await semanticService.findSimilar(args.itemKey, {
        topK: args.topK,
        minScore: args.minScore
      });

      const response = {
        mode: 'similar',
        sourceItemKey: args.itemKey,
        data: results,
        metadata: {
          extractedAt: new Date().toISOString(),
          resultCount: results.length
        }
      };

      return applyGlobalAIInstructions(response, 'find_similar');
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Find similar error: ${error}`, 'error');
      throw error;
    }
  }

  private async callBuildSemanticIndex(args: any): Promise<any> {
    try {
      const semanticService = getSemanticSearchService();
      await semanticService.initialize();

      // Check if already indexing
      const currentProgress = semanticService.getIndexProgress();
      if (currentProgress.status === 'indexing') {
        return applyGlobalAIInstructions({
          status: 'already_running',
          total: currentProgress.total,
          processed: currentProgress.processed,
          message: `Indexing already in progress: ${currentProgress.processed}/${currentProgress.total}. Use semantic_status to check progress, pause_semantic_index to pause, or abort_semantic_index to stop.`
        }, 'build_semantic_index');
      }

      // Start indexing in background (don't await)
      const indexPromise = semanticService.buildIndex({
        itemKeys: args.itemKeys,
        rebuild: args.rebuild || false
      });

      // Store promise for potential future reference (optional)
      // Don't await - let it run in background

      // Log when indexing completes (for debugging)
      indexPromise.then(progress => {
        ztoolkit.log(`[StreamableMCP] Background indexing completed: ${progress.processed}/${progress.total}, status=${progress.status}`);
      }).catch(error => {
        ztoolkit.log(`[StreamableMCP] Background indexing failed: ${error}`, 'error');
      });

      // Wait a short time to get initial progress
      await new Promise(resolve => setTimeout(resolve, 100));
      const initialProgress = semanticService.getIndexProgress();

      return applyGlobalAIInstructions({
        status: 'started',
        total: initialProgress.total,
        processed: initialProgress.processed,
        message: `Indexing started for ${initialProgress.total} items. Use semantic_status to check progress, pause_semantic_index to pause, or abort_semantic_index to stop.`
      }, 'build_semantic_index');
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Build index error: ${error}`, 'error');
      throw error;
    }
  }

  private async callSemanticStatus(): Promise<any> {
    try {
      const semanticService = getSemanticSearchService();
      const isReady = await semanticService.isReady();
      const stats = isReady ? await semanticService.getStats() : null;
      const progress = semanticService.getIndexProgress();

      return applyGlobalAIInstructions({
        ready: isReady,
        initialized: stats?.serviceStatus.initialized || false,
        fallbackMode: stats?.serviceStatus.fallbackMode || false,
        indexProgress: progress,
        indexStats: stats?.indexStats || null,
        message: !isReady
          ? 'Semantic search service not initialized'
          : stats?.serviceStatus.fallbackMode
            ? 'Running in fallback mode (API not configured)'
            : `Semantic search ready with ${stats?.indexStats.totalItems || 0} indexed items`
      }, 'semantic_status');
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Semantic status error: ${error}`, 'error');
      return applyGlobalAIInstructions({
        ready: false,
        error: String(error)
      }, 'semantic_status');
    }
  }

  private async callConfigureEmbedding(args: any): Promise<any> {
    try {
      const { getEmbeddingService } = await import('./semantic/embeddingService');
      const embeddingService = getEmbeddingService();

      // Get current config first
      const currentConfig = embeddingService.getConfig();

      // Update config if any parameters provided
      const newConfig: any = {};
      if (args?.apiBase) newConfig.apiBase = args.apiBase;
      if (args?.apiKey) newConfig.apiKey = args.apiKey;
      if (args?.model) newConfig.model = args.model;
      if (args?.dimensions) newConfig.dimensions = args.dimensions;

      if (Object.keys(newConfig).length > 0) {
        embeddingService.updateConfig(newConfig);
        ztoolkit.log(`[StreamableMCP] Embedding config updated: ${JSON.stringify({ ...newConfig, apiKey: newConfig.apiKey ? '***' : undefined })}`);
      }

      // Test connection if requested (default true) and API key is configured
      const shouldTest = args?.test !== false;
      let testResult = null;

      if (shouldTest && (args?.apiKey || currentConfig.apiKeyConfigured)) {
        testResult = await embeddingService.testConnection();
      }

      // Get updated config
      const updatedConfig = embeddingService.getConfig();

      return applyGlobalAIInstructions({
        success: true,
        config: {
          apiBase: updatedConfig.apiBase,
          model: updatedConfig.model,
          dimensions: updatedConfig.dimensions,
          apiKeyConfigured: updatedConfig.apiKeyConfigured
        },
        testResult: testResult,
        message: testResult?.success
          ? `Embedding API configured and tested successfully. Model: ${updatedConfig.model}, Dimensions: ${testResult.dimensions}`
          : testResult
            ? `Configuration saved but connection test failed: ${testResult.message}`
            : 'Configuration saved. Use test=true to verify connection.'
      }, 'configure_embedding');
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Configure embedding error: ${error}`, 'error');
      return applyGlobalAIInstructions({
        success: false,
        error: String(error)
      }, 'configure_embedding');
    }
  }

  private async callPauseSemanticIndex(): Promise<any> {
    try {
      const semanticService = getSemanticSearchService();
      const progress = semanticService.getIndexProgress();

      if (progress.status !== 'indexing') {
        return applyGlobalAIInstructions({
          success: false,
          message: `Cannot pause: indexing is not running (current status: ${progress.status})`,
          progress
        }, 'pause_semantic_index');
      }

      semanticService.pauseIndex();
      const updatedProgress = semanticService.getIndexProgress();

      return applyGlobalAIInstructions({
        success: true,
        message: `Indexing paused at ${updatedProgress.processed}/${updatedProgress.total} items`,
        progress: updatedProgress
      }, 'pause_semantic_index');
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Pause index error: ${error}`, 'error');
      return applyGlobalAIInstructions({
        success: false,
        error: String(error)
      }, 'pause_semantic_index');
    }
  }

  private async callResumeSemanticIndex(): Promise<any> {
    try {
      const semanticService = getSemanticSearchService();
      const progress = semanticService.getIndexProgress();

      if (progress.status !== 'paused') {
        return applyGlobalAIInstructions({
          success: false,
          message: `Cannot resume: indexing is not paused (current status: ${progress.status})`,
          progress
        }, 'resume_semantic_index');
      }

      semanticService.resumeIndex();
      const updatedProgress = semanticService.getIndexProgress();

      return applyGlobalAIInstructions({
        success: true,
        message: `Indexing resumed from ${updatedProgress.processed}/${updatedProgress.total} items`,
        progress: updatedProgress
      }, 'resume_semantic_index');
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Resume index error: ${error}`, 'error');
      return applyGlobalAIInstructions({
        success: false,
        error: String(error)
      }, 'resume_semantic_index');
    }
  }

  private async callAbortSemanticIndex(): Promise<any> {
    try {
      const semanticService = getSemanticSearchService();
      const progress = semanticService.getIndexProgress();

      if (progress.status !== 'indexing' && progress.status !== 'paused') {
        return applyGlobalAIInstructions({
          success: false,
          message: `Cannot abort: no indexing in progress (current status: ${progress.status})`,
          progress
        }, 'abort_semantic_index');
      }

      semanticService.abortIndex();

      // Wait briefly for status to update
      await new Promise(resolve => setTimeout(resolve, 100));
      const updatedProgress = semanticService.getIndexProgress();

      return applyGlobalAIInstructions({
        success: true,
        message: `Indexing aborted at ${updatedProgress.processed}/${updatedProgress.total} items. Progress has been saved.`,
        progress: updatedProgress
      }, 'abort_semantic_index');
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Abort index error: ${error}`, 'error');
      return applyGlobalAIInstructions({
        success: false,
        error: String(error)
      }, 'abort_semantic_index');
    }
  }

  private async callFulltextDatabase(args: any): Promise<any> {
    try {
      const { getVectorStore } = await import('./semantic/vectorStore');
      const vectorStore = getVectorStore();
      await vectorStore.initialize();

      const { action, query, itemKeys, collectionKey, limit = 20, caseSensitive = false, skipExisting = true } = args;

      switch (action) {
        case 'extract': {
          // Extract PDF content and save to database
          return await this.extractContentToDatabase(vectorStore, { itemKeys, collectionKey, limit, skipExisting });
        }

        case 'list': {
          const cachedItems = await vectorStore.listCachedContent();
          const limitedItems = cachedItems.slice(0, limit);

          return applyGlobalAIInstructions({
            action: 'list',
            data: limitedItems,
            metadata: {
              extractedAt: new Date().toISOString(),
              totalCached: cachedItems.length,
              returned: limitedItems.length,
              message: `Found ${cachedItems.length} items in full-text database`
            }
          }, 'fulltext_database');
        }

        case 'search': {
          if (!query) {
            throw new Error('query is required for search action');
          }

          const searchResults = await vectorStore.searchCachedContent(query, { limit, caseSensitive });

          return applyGlobalAIInstructions({
            action: 'search',
            query,
            data: searchResults,
            metadata: {
              extractedAt: new Date().toISOString(),
              resultCount: searchResults.length,
              caseSensitive,
              message: `Found ${searchResults.length} items matching "${query}"`
            }
          }, 'fulltext_database');
        }

        case 'get': {
          if (!itemKeys || itemKeys.length === 0) {
            throw new Error('itemKeys is required for get action');
          }

          const contentMap = await vectorStore.getFullContentBatch(itemKeys);
          const results: Array<{ itemKey: string; content: string | null; contentLength: number }> = [];

          for (const key of itemKeys) {
            const content = contentMap.get(key) || null;
            results.push({
              itemKey: key,
              content,
              contentLength: content ? content.length : 0
            });
          }

          return applyGlobalAIInstructions({
            action: 'get',
            data: results,
            metadata: {
              extractedAt: new Date().toISOString(),
              requested: itemKeys.length,
              found: results.filter(r => r.content !== null).length,
              message: `Retrieved content for ${results.filter(r => r.content !== null).length}/${itemKeys.length} items`
            }
          }, 'fulltext_database');
        }

        case 'delete': {
          if (!itemKeys || itemKeys.length === 0) {
            throw new Error('itemKeys is required for delete action');
          }

          let deleted = 0;
          for (const key of itemKeys) {
            await vectorStore.deleteCachedContent(key);
            deleted++;
          }

          return applyGlobalAIInstructions({
            action: 'delete',
            data: { deletedCount: deleted, itemKeys },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Deleted ${deleted} items from full-text database`
            }
          }, 'fulltext_database');
        }

        case 'stats': {
          const stats = await vectorStore.getStats();

          // Format size nicely
          const formatSize = (bytes: number) => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
          };

          return applyGlobalAIInstructions({
            action: 'stats',
            data: {
              cachedItems: stats.cachedContentItems,
              cachedContentSize: stats.cachedContentSizeBytes,
              cachedContentSizeFormatted: formatSize(stats.cachedContentSizeBytes),
              indexedItems: stats.totalItems,
              totalVectors: stats.totalVectors,
              zhVectors: stats.zhVectors,
              enVectors: stats.enVectors,
              extractionProgress: this.extractionProgress
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Full-text database: ${stats.cachedContentItems} items, ${formatSize(stats.cachedContentSizeBytes)}`
            }
          }, 'fulltext_database');
        }

        case 'status': {
          return applyGlobalAIInstructions({
            action: 'status',
            data: {
              ...this.extractionProgress,
              elapsedTime: this.extractionProgress.startTime
                ? Math.floor((Date.now() - this.extractionProgress.startTime) / 1000)
                : 0
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: this.extractionProgress.status === 'idle'
                ? 'No extraction in progress'
                : `Extraction ${this.extractionProgress.status}: ${this.extractionProgress.processed}/${this.extractionProgress.total} items`
            }
          }, 'fulltext_database');
        }

        case 'pause': {
          if (this.extractionProgress.status !== 'extracting') {
            return applyGlobalAIInstructions({
              action: 'pause',
              success: false,
              data: this.extractionProgress,
              metadata: {
                extractedAt: new Date().toISOString(),
                message: `Cannot pause: extraction is not running (current status: ${this.extractionProgress.status})`
              }
            }, 'fulltext_database');
          }

          this._extractionPaused = true;
          this.extractionProgress.status = 'paused';

          return applyGlobalAIInstructions({
            action: 'pause',
            success: true,
            data: this.extractionProgress,
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Extraction paused at ${this.extractionProgress.processed}/${this.extractionProgress.total} items`
            }
          }, 'fulltext_database');
        }

        case 'resume': {
          if (this.extractionProgress.status !== 'paused') {
            return applyGlobalAIInstructions({
              action: 'resume',
              success: false,
              data: this.extractionProgress,
              metadata: {
                extractedAt: new Date().toISOString(),
                message: `Cannot resume: extraction is not paused (current status: ${this.extractionProgress.status})`
              }
            }, 'fulltext_database');
          }

          this._extractionPaused = false;
          this.extractionProgress.status = 'extracting';

          // Resolve the pause promise to continue extraction
          if (this._extractionPauseResolve) {
            this._extractionPauseResolve();
            this._extractionPauseResolve = null;
          }

          return applyGlobalAIInstructions({
            action: 'resume',
            success: true,
            data: this.extractionProgress,
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Extraction resumed from ${this.extractionProgress.processed}/${this.extractionProgress.total} items`
            }
          }, 'fulltext_database');
        }

        case 'abort': {
          if (this.extractionProgress.status !== 'extracting' && this.extractionProgress.status !== 'paused') {
            return applyGlobalAIInstructions({
              action: 'abort',
              success: false,
              data: this.extractionProgress,
              metadata: {
                extractedAt: new Date().toISOString(),
                message: `Cannot abort: no extraction in progress (current status: ${this.extractionProgress.status})`
              }
            }, 'fulltext_database');
          }

          this._extractionAborted = true;
          this._extractionPaused = false;
          this.extractionProgress.status = 'aborted';

          // Resolve the pause promise if we were paused
          if (this._extractionPauseResolve) {
            this._extractionPauseResolve();
            this._extractionPauseResolve = null;
          }

          return applyGlobalAIInstructions({
            action: 'abort',
            success: true,
            data: this.extractionProgress,
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Extraction aborted at ${this.extractionProgress.processed}/${this.extractionProgress.total} items. Progress has been saved.`
            }
          }, 'fulltext_database');
        }

        default:
          throw new Error(`Unknown action: ${action}. Use extract, list, search, get, delete, stats, status, pause, resume, or abort.`);
      }
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Fulltext database error: ${error}`, 'error');
      return applyGlobalAIInstructions({
        success: false,
        error: String(error)
      }, 'fulltext_database');
    }
  }

  /**
   * Extract content from items and save to full-text database
   */
  private async extractContentToDatabase(
    vectorStore: any,
    options: { itemKeys?: string[]; collectionKey?: string; limit?: number; skipExisting?: boolean }
  ): Promise<any> {
    const { itemKeys, collectionKey, limit = 100, skipExisting = true } = options;

    // Check if already extracting
    if (this.extractionProgress.status === 'extracting' || this.extractionProgress.status === 'paused') {
      return applyGlobalAIInstructions({
        action: 'extract',
        status: 'already_running',
        data: this.extractionProgress,
        metadata: {
          extractedAt: new Date().toISOString(),
          message: `Extraction already in progress: ${this.extractionProgress.processed}/${this.extractionProgress.total}. Use action=status to check progress, action=pause to pause, or action=abort to stop.`
        }
      }, 'fulltext_database');
    }

    // Get items to extract
    let items: any[] = [];

    if (itemKeys && itemKeys.length > 0) {
      // Extract specific items
      for (const key of itemKeys) {
        try {
          const item = await Zotero.Items.getByLibraryAndKeyAsync(1, key);
          if (item && item.isRegularItem?.()) {
            items.push(item);
          }
        } catch (e) {
          ztoolkit.log(`[FulltextDB] Failed to get item ${key}: ${e}`, 'warn');
        }
      }
    } else if (collectionKey) {
      // Extract items from collection
      const collection = await Zotero.Collections.getByLibraryAndKeyAsync(1, collectionKey);
      if (collection) {
        const childItems = collection.getChildItems();
        items = childItems.filter((item: any) => item.isRegularItem?.());
      }
    } else {
      // Extract all items in library
      const allItems = await Zotero.Items.getAll(1);
      items = allItems.filter((item: any) => item.isRegularItem?.());
    }

    // Apply limit
    if (limit && items.length > limit) {
      items = items.slice(0, limit);
    }

    // Get existing cached keys if skipExisting
    let existingKeys = new Set<string>();
    if (skipExisting) {
      const cachedList = await vectorStore.listCachedContent();
      existingKeys = new Set(cachedList.map((c: any) => c.itemKey));
    }

    // Filter out existing items
    const itemsToExtract = skipExisting
      ? items.filter(item => !existingKeys.has(item.key))
      : items;

    ztoolkit.log(`[FulltextDB] Extracting ${itemsToExtract.length} items (${items.length - itemsToExtract.length} skipped)`);

    // Initialize extraction progress
    this._extractionPaused = false;
    this._extractionAborted = false;
    this._extractionPauseResolve = null;
    this.extractionProgress = {
      total: itemsToExtract.length,
      processed: 0,
      extracted: 0,
      failed: 0,
      status: 'extracting',
      startTime: Date.now()
    };

    // Start extraction in background
    const extractPromise = this.doExtractContent(vectorStore, itemsToExtract);

    // Don't await - let it run in background
    extractPromise.then(result => {
      ztoolkit.log(`[FulltextDB] Extraction completed: ${result.extracted}/${result.total} items`);
    }).catch(error => {
      ztoolkit.log(`[FulltextDB] Extraction failed: ${error}`, 'error');
      this.extractionProgress.status = 'error';
      this.extractionProgress.error = String(error);
    });

    return applyGlobalAIInstructions({
      action: 'extract',
      status: 'started',
      data: {
        totalItems: items.length,
        toExtract: itemsToExtract.length,
        skipped: items.length - itemsToExtract.length
      },
      metadata: {
        extractedAt: new Date().toISOString(),
        message: `Started extracting ${itemsToExtract.length} items. Use action=status to check progress, action=pause to pause, or action=abort to stop.`
      }
    }, 'fulltext_database');
  }

  /**
   * Wait while extraction is paused
   */
  private async waitWhileExtractionPaused(): Promise<void> {
    if (!this._extractionPaused) return;

    ztoolkit.log('[FulltextDB] Extraction paused, waiting for resume...');

    return new Promise<void>((resolve) => {
      this._extractionPauseResolve = resolve;
    });
  }

  /**
   * Actually extract content (runs in background)
   */
  private async doExtractContent(vectorStore: any, items: any[]): Promise<{ total: number; extracted: number; failed: number }> {
    const { getSemanticSearchService } = await import('./semantic');
    const semanticService = getSemanticSearchService();
    await semanticService.initialize();

    let extracted = 0;
    let failed = 0;

    for (const item of items) {
      // Check if aborted
      if (this._extractionAborted) {
        ztoolkit.log('[FulltextDB] Extraction aborted by user');
        break;
      }

      // Wait if paused
      await this.waitWhileExtractionPaused();

      // Check again after resuming (might have been aborted while paused)
      if (this._extractionAborted) {
        ztoolkit.log('[FulltextDB] Extraction aborted after pause');
        break;
      }

      // Update current item
      this.extractionProgress.currentItem = item.key;

      try {
        // Use semanticSearchService's extractItemContent method
        const content = await (semanticService as any).extractItemContent(item, null);

        if (content && content.trim()) {
          // Calculate hash
          const hash = this.hashContent(content);

          // Save to cache
          await vectorStore.setCachedContent(item.key, content, hash);
          extracted++;
          this.extractionProgress.extracted = extracted;

          ztoolkit.log(`[FulltextDB] Extracted: ${item.key} (${content.length} chars)`);
        }
      } catch (error) {
        failed++;
        this.extractionProgress.failed = failed;
        ztoolkit.log(`[FulltextDB] Failed to extract ${item.key}: ${error}`, 'warn');
      }

      // Update progress
      this.extractionProgress.processed++;
    }

    // Update final status
    if (this._extractionAborted) {
      this.extractionProgress.status = 'aborted';
    } else {
      this.extractionProgress.status = 'completed';
    }
    this.extractionProgress.currentItem = undefined;

    return { total: items.length, extracted, failed };
  }

  /**
   * Simple hash function for content
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Format tool result for MCP response with intelligent content type detection
   */
  private formatToolResult(result: any, toolName: string, args: any): any {
    // Check if client explicitly requested text format
    const requestedTextFormat = args?.format === 'text';
    
    // If result is already a string (text format), wrap it in MCP content format
    if (typeof result === 'string') {
      return {
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
        isError: false,
      };
    }
    
    // For structured data, provide both JSON and formatted options
    if (typeof result === 'object' && result !== null) {
      // If explicitly requested text format, convert to readable text
      if (requestedTextFormat) {
        return {
          content: [
            {
              type: 'text',
              text: this.formatObjectAsText(result, toolName),
            },
          ],
          isError: false,
        };
      }
      
      // Default: provide structured JSON with formatted preview
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: false,
        // Include raw structured data for programmatic access
        _structuredData: result,
        _contentType: 'application/json'
      };
    }
    
    // Fallback for other types
    return {
      content: [
        {
          type: 'text',
          text: String(result),
        },
      ],
      isError: false,
    };
  }

  /**
   * Format object as human-readable text based on tool type
   */
  private formatObjectAsText(obj: any, toolName: string): string {
    switch (toolName) {
      case 'get_content':
        return this.formatContentAsText(obj);
      case 'search_library':
        return this.formatSearchResultsAsText(obj);
      case 'get_annotations':
        return this.formatAnnotationsAsText(obj);
      default:
        return JSON.stringify(obj, null, 2);
    }
  }

  private formatContentAsText(contentResult: any): string {
    const parts = [];
    
    if (contentResult.title) {
      parts.push(`TITLE: ${contentResult.title}\n`);
    }
    
    if (contentResult.content) {
      if (contentResult.content.abstract) {
        parts.push(`ABSTRACT:\n${contentResult.content.abstract.content}\n`);
      }
      
      if (contentResult.content.attachments) {
        for (const att of contentResult.content.attachments) {
          parts.push(`ATTACHMENT (${att.filename || att.type}):\n${att.content}\n`);
        }
      }
      
      if (contentResult.content.notes) {
        for (const note of contentResult.content.notes) {
          parts.push(`NOTE (${note.title}):\n${note.content}\n`);
        }
      }
    }
    
    return parts.join('\n---\n\n');
  }

  private formatSearchResultsAsText(searchResult: any): string {
    if (!searchResult.results || !Array.isArray(searchResult.results)) {
      return JSON.stringify(searchResult, null, 2);
    }
    
    const parts = [`SEARCH RESULTS (${searchResult.results.length} items):\n`];
    
    searchResult.results.forEach((item: any, index: number) => {
      parts.push(`${index + 1}. ${item.title || 'Untitled'}`);
      if (item.creators && item.creators.length > 0) {
        parts.push(`   Authors: ${item.creators.map((c: any) => c.name || `${c.firstName} ${c.lastName}`).join(', ')}`);
      }
      if (item.date) {
        parts.push(`   Date: ${item.date}`);
      }
      if (item.itemKey) {
        parts.push(`   Key: ${item.itemKey}`);
      }
      parts.push('');
    });
    
    return parts.join('\n');
  }

  private formatAnnotationsAsText(annotationResult: any): string {
    if (!annotationResult.data || !Array.isArray(annotationResult.data)) {
      return JSON.stringify(annotationResult, null, 2);
    }
    
    const parts = [`ANNOTATIONS (${annotationResult.data.length} items):\n`];
    
    annotationResult.data.forEach((ann: any, index: number) => {
      parts.push(`${index + 1}. [${ann.type.toUpperCase()}] ${ann.content}`);
      if (ann.page) {
        parts.push(`   Page: ${ann.page}`);
      }
      if (ann.dateModified) {
        parts.push(`   Modified: ${ann.dateModified}`);
      }
      parts.push('');
    });
    
    return parts.join('\n');
  }

  private createResponse(id: string | number, result: any): MCPResponse {
    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  }

  private createError(id: string | number, code: number, message: string, data?: any): MCPResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
  }

  /**
   * Get server status and capabilities
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      serverInfo: this.serverInfo,
      protocolVersion: '2024-11-05',
      supportedMethods: [
        'initialize',
        'initialized', 
        'tools/list',
        'tools/call',
        'resources/list',
        'prompts/list',
        'ping'
      ],
      availableTools: [
        'search_library',
        'search_annotations',
        'get_item_details',
        'get_annotations',
        'get_content',
        'get_collections',
        'search_collections',
        'get_collection_details',
        'get_collection_items',
        'search_fulltext',
        'get_item_abstract',
        // Semantic Search Tools
        'semantic_search',
        'find_similar',
        'build_semantic_index',
        'semantic_status',
        'configure_embedding',
        'pause_semantic_index',
        'resume_semantic_index',
        'abort_semantic_index',
        // Full-text Database Tool
        'fulltext_database'
      ],
      transport: {
        type: "streamable-http",
        keepAliveSupported: true,
        maxConnections: 100
      }
    };
  }

  /**
   * Get fulltext search mode configuration
   */
  private getFulltextModeConfiguration(mode: string): any {
    const modeConfigs = {
      'minimal': {
        contextLength: 100,
        maxResults: 20
      },
      'preview': {
        contextLength: 200,
        maxResults: 50  
      },
      'standard': {
        contextLength: 250,
        maxResults: 100
      },
      'complete': {
        contextLength: 400,
        maxResults: 200
      }
    };

    return modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs['standard'];
  }

  /**
   * Get search mode configuration
   */
  private getSearchModeConfiguration(mode: string): any {
    const modeConfigs = {
      'minimal': {
        limit: 30
      },
      'preview': {
        limit: 100
      },
      'standard': {
        limit: 200
      },
      'complete': {
        limit: 500
      }
    };

    return modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs['standard'];
  }

  /**
   * Get collection mode configuration
   */
  private getCollectionModeConfiguration(mode: string): any {
    const modeConfigs = {
      'minimal': {
        limit: 20
      },
      'preview': {
        limit: 50
      },
      'standard': {
        limit: 100
      },
      'complete': {
        limit: 500
      }
    };

    return modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs['standard'];
  }

  /**
   * Get item details mode configuration
   */
  private getItemDetailsModeConfiguration(mode: string): any {
    const modeConfigs = {
      'minimal': {
        fields: ['key', 'title', 'creators', 'date', 'itemType']
      },
      'preview': {
        fields: ['key', 'title', 'creators', 'date', 'itemType', 'abstractNote', 'tags', 'collections']
      },
      'standard': {
        fields: null // Include most fields (default behavior)
      },
      'complete': {
        fields: null // Include all fields
      }
    };

    return modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs['standard'];
  }
}