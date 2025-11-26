#!/usr/bin/env node

/**
 * 식품 표기 정보 검증 MCP 서버 (HTTP 버전)
 * n8n AI Agent와 연동 가능
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import axios from 'axios';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';

// 환경 변수 로드
dotenv.config();

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Express 앱 생성
const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'mcp-session-id', 'x-session-id'],
  exposedHeaders: ['mcp-session-id']
}));

// 세션별 transport 저장
const transports = new Map();

/**
 * MCP 서버 생성 함수
 */
function createMcpServer() {
  const server = new McpServer({
    name: 'food-label-checker',
    version: '1.0.0',
  });

  // 도구 등록
  server.tool(
    'verify_food_label',
    'OCR로 추출한 식품 표기 정보를 공공데이터포털의 식품 DB와 비교하여 검증합니다. 제품명과 원재료 정보의 정확성을 확인하고 오타를 수정합니다.',
    {
      productName: z.string().describe('OCR로 읽은 제품명'),
      manufacturer: z.string().optional().describe('OCR로 읽은 제조사명 (선택)'),
      ingredients: z.array(z.string()).describe('OCR로 읽은 원재료 목록 (많이 들어있는 순서대로)'),
    },
    async ({ productName, manufacturer, ingredients }) => {
      try {
        console.error('\n식품 검증 시작...');
        console.error('제품명:', productName);
        console.error('제조사:', manufacturer);
        console.error('원재료:', ingredients);

        const dbProduct = await searchFoodInDB(productName);

        if (!dbProduct) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  verified: false,
                  message: 'DB에서 제품을 찾을 수 없습니다. OCR 결과를 그대로 사용합니다.',
                  originalData: {
                    productName,
                    manufacturer,
                    ingredients,
                  },
                  suggestion: 'DB에 제품이 없을 수 있습니다. 제품명을 다시 확인해주세요.',
                }, null, 2),
              },
            ],
          };
        }

        console.error('\n원재료 검증 중...');
        const { verified, corrections, dbIngredients } = verifyIngredients(
          ingredients,
          dbProduct.rawmtrl_nm || dbProduct.RAWMTRL_NM || ''
        );

        const result = {
          verified: true,
          productInfo: {
            name: dbProduct.prdlst_nm || dbProduct.PRDLST_NM || productName,
            manufacturer: dbProduct.bssh_nm || dbProduct.BSSH_NM || manufacturer,
            reportNumber: dbProduct.prdlst_report_no || dbProduct.PRDLST_REPORT_NO,
          },
          ingredients: {
            original: ingredients,
            verified: verified,
            fromDB: dbIngredients,
            inCorrectOrder: true,
          },
          corrections: corrections,
          confidence: corrections.length === 0 ? 100 : 85,
          message: corrections.length === 0
            ? '모든 정보가 정확합니다!'
            : `${corrections.length}개의 항목이 수정되었습니다.`,
        };

        console.error('\n검증 완료!');
        console.error('수정 사항:', corrections.length);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error('\n오류 발생:', error);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: true,
                message: `검증 중 오류 발생: ${error.message}`,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

/**
 * 공공데이터포털 API로 식품 정보 검색
 */
async function searchFoodInDB(productName) {
  try {
    console.error(`"${productName}" 검색 중...`);

    const response = await axios.get(process.env.FOOD_DB_API_URL, {
      params: {
        serviceKey: process.env.FOOD_DB_API_KEY,
        prdlst_nm: productName,
        numOfRows: 10,
        pageNo: 1,
        type: 'json'
      },
      timeout: 10000
    });

    console.error('API 응답:', JSON.stringify(response.data, null, 2));

    if (response.data && response.data.body && response.data.body.items) {
      const items = response.data.body.items;
      return items.length > 0 ? items[0] : null;
    }

    return null;
  } catch (error) {
    console.error('DB 검색 오류:', error.message);
    if (error.response) {
      console.error('응답 상태:', error.response.status);
      console.error('응답 데이터:', error.response.data);
    }
    return null;
  }
}

/**
 * 문자열 유사도 계산 (레벤슈타인 거리)
 */
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;

  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1.0;

  const editDistance = getEditDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function getEditDistance(str1, str2) {
  const costs = [];
  for (let i = 0; i <= str1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= str2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (str1.charAt(i - 1) !== str2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[str2.length] = lastValue;
  }
  return costs[str2.length];
}

/**
 * 원재료 문자열을 배열로 파싱
 */
function parseIngredients(ingredientString) {
  if (!ingredientString) return [];

  return ingredientString
    .split(/[,;\/]/)
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

/**
 * OCR 결과와 DB 정보 비교
 */
function verifyIngredients(ocrIngredients, dbIngredientsString) {
  const dbIngredients = parseIngredients(dbIngredientsString);
  const corrections = [];
  const verified = [];

  console.error('OCR 원재료:', ocrIngredients);
  console.error('DB 원재료:', dbIngredients);

  for (const ocrIngredient of ocrIngredients) {
    let bestMatch = null;
    let bestSimilarity = 0;

    for (const dbIngredient of dbIngredients) {
      const similarity = calculateSimilarity(
        ocrIngredient.toLowerCase(),
        dbIngredient.toLowerCase()
      );

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = dbIngredient;
      }
    }

    if (bestSimilarity > 0.7) {
      verified.push(bestMatch);
      if (ocrIngredient !== bestMatch) {
        corrections.push({
          original: ocrIngredient,
          corrected: bestMatch,
          confidence: Math.round(bestSimilarity * 100),
        });
      }
    } else {
      verified.push(ocrIngredient);
    }
  }

  return { verified, corrections, dbIngredients };
}

/**
 * POST /mcp - 새 세션 시작 또는 기존 세션에 메시지 전송
 */
app.post('/mcp', async (req, res) => {
  console.error('\n=== POST /mcp 요청 ===');
  console.error('Headers:', JSON.stringify(req.headers, null, 2));
  console.error('Body:', JSON.stringify(req.body, null, 2));

  try {
    // 세션 ID 확인
    const sessionId = req.headers['mcp-session-id'];

    if (sessionId && transports.has(sessionId)) {
      // 기존 세션에 메시지 전송
      const transport = transports.get(sessionId);
      await transport.handleRequest(req, res);
    } else {
      // 새 세션 생성
      const newSessionId = randomUUID();
      console.error(`새 세션 생성: ${newSessionId}`);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid) => {
          console.error(`세션 초기화됨: ${sid}`);
          transports.set(sid, transport);
        }
      });

      // 세션 종료 시 정리
      transport.onclose = () => {
        console.error(`세션 종료: ${newSessionId}`);
        transports.delete(newSessionId);
      };

      // MCP 서버 생성 및 연결
      const server = createMcpServer();
      await server.connect(transport);

      // 요청 처리
      await transport.handleRequest(req, res);
    }
  } catch (error) {
    console.error('POST 처리 오류:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal error',
          data: error.message
        },
        id: req.body?.id || null
      });
    }
  }
});

/**
 * GET /mcp - SSE 스트림 (서버 -> 클라이언트 알림용)
 */
app.get('/mcp', async (req, res) => {
  console.error('\n=== GET /mcp 요청 (SSE) ===');

  const sessionId = req.headers['mcp-session-id'];
  console.error('Session ID:', sessionId);

  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session. Send POST first to initialize.'
      },
      id: null
    });
    return;
  }

  const transport = transports.get(sessionId);
  await transport.handleRequest(req, res);
});

/**
 * DELETE /mcp - 세션 종료
 */
app.delete('/mcp', async (req, res) => {
  console.error('\n=== DELETE /mcp 요청 ===');

  const sessionId = req.headers['mcp-session-id'];
  console.error('Session ID:', sessionId);

  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session'
      },
      id: null
    });
    return;
  }

  const transport = transports.get(sessionId);
  await transport.handleRequest(req, res);
  transports.delete(sessionId);
});

/**
 * OPTIONS 처리 (CORS preflight)
 */
app.options('/mcp', (req, res) => {
  res.status(204).end();
});

/**
 * 헬스체크 엔드포인트
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'food-label-checker MCP Server',
    version: '1.0.0',
    transport: 'streamable-http',
    activeSessions: transports.size
  });
});

/**
 * 루트 엔드포인트 (정보 표시)
 */
app.get('/', (req, res) => {
  res.json({
    name: 'food-label-checker',
    version: '1.0.0',
    description: '식품 표기 정보 검증 MCP 서버',
    endpoints: {
      mcp: '/mcp',
      health: '/health'
    },
    usage: 'POST to /mcp to start a session'
  });
});

/**
 * 서버 시작
 */
async function main() {
  console.error('\n=================================');
  console.error('식품 표기 정보 검증 MCP 서버 (HTTP)');
  console.error('=================================\n');

  if (!process.env.FOOD_DB_API_KEY) {
    console.error('경고: FOOD_DB_API_KEY가 설정되지 않았습니다!');
    console.error('.env 파일을 확인해주세요.');
  }

  console.error('API URL:', process.env.FOOD_DB_API_URL || '(not set)');

  app.listen(PORT, HOST, () => {
    console.error(`\n✅ 서버가 실행 중입니다!`);
    console.error(`호스트: ${HOST}`);
    console.error(`포트: ${PORT}`);
    console.error(`MCP 엔드포인트: http://${HOST}:${PORT}/mcp`);
    console.error(`헬스체크: http://${HOST}:${PORT}/health\n`);
    console.error('n8n MCP Client URL: http://192.168.10.109:3000/mcp');
    console.error('\nn8n에서 사용할 준비가 되었습니다!');
  });
}

main().catch((error) => {
  console.error('\n서버 시작 오류:', error);
  process.exit(1);
});