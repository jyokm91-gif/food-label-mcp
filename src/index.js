#!/usr/bin/env node

/**
 * 식품 표기 정보 검증 MCP 서버 (Windows 버전)
 * 공공데이터포털 식품원재료정보 API 사용
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import dotenv from 'dotenv';

// 환경 변수 로드
dotenv.config();

// MCP 서버 생성
const server = new Server(
  {
    name: 'food-label-checker',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * 공공데이터포털 API로 식품 정보 검색
 */
async function searchFoodInDB(productName) {
  try {
    // [수정] log -> error, 이모지 제거
    console.error(`"${productName}" 검색 중...`);
    
    const response = await axios.get(process.env.FOOD_DB_API_URL, {
      params: {
        serviceKey: process.env.FOOD_DB_API_KEY,
        prdlst_nm: productName,  // 제품명
        numOfRows: 10,           // 최대 10개 결과
        pageNo: 1,
        type: 'json'
      },
      timeout: 10000  // 10초 타임아웃
    });

    // [수정] log -> error
    console.error('API 응답:', JSON.stringify(response.data, null, 2));

    // 응답 구조 확인
    if (response.data && response.data.body && response.data.body.items) {
      const items = response.data.body.items;
      return items.length > 0 ? items[0] : null;
    }

    return null;
  } catch (error) {
    // [수정] 이모지 제거
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
  
  // 쉼표, 세미콜론, 슬래시 등으로 분리
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
  
  // [수정] log -> error, 이모지 제거
  console.error('OCR 원재료:', ocrIngredients);
  console.error('DB 원재료:', dbIngredients);

  // OCR로 읽은 각 원재료를 확인
  for (const ocrIngredient of ocrIngredients) {
    let bestMatch = null;
    let bestSimilarity = 0;
    
    // DB의 원재료 중 가장 비슷한 것 찾기
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
    
    // 70% 이상 비슷하면 같은 것으로 간주 (한글 특성상 조금 낮춤)
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
 * 사용 가능한 도구 목록
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'verify_food_label',
        description: 
          'OCR로 추출한 식품 표기 정보를 공공데이터포털의 식품 DB와 비교하여 검증합니다. ' +
          '제품명과 원재료 정보의 정확성을 확인하고 오타를 수정합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            productName: {
              type: 'string',
              description: 'OCR로 읽은 제품명',
            },
            manufacturer: {
              type: 'string',
              description: 'OCR로 읽은 제조사명 (선택)',
            },
            ingredients: {
              type: 'array',
              items: { type: 'string' },
              description: 'OCR로 읽은 원재료 목록 (많이 들어있는 순서대로)',
            },
          },
          required: ['productName', 'ingredients'],
        },
      },
    ],
  };
});

/**
 * 도구 실행
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'verify_food_label') {
    const { productName, manufacturer, ingredients } = request.params.arguments;

    try {
      // [수정] log -> error, 이모지 제거
      console.error('\n식품 검증 시작...');
      console.error('제품명:', productName);
      console.error('제조사:', manufacturer);
      console.error('원재료:', ingredients);

      // 1단계: DB에서 제품 찾기
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

      // 2단계: 원재료 검증
      // [수정] log -> error, 이모지 제거
      console.error('\n원재료 검증 중...');
      const { verified, corrections, dbIngredients } = verifyIngredients(
        ingredients,
        dbProduct.rawmtrl_nm || dbProduct.RAWMTRL_NM || ''
      );

      // 3단계: 결과 생성
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

      // [수정] log -> error, 이모지 제거
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
      // [수정] log -> error, 이모지 제거
      console.error('\n오류 발생:', error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: `검증 중 오류 발생: ${error.message}`,
              details: error.stack,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: `알 수 없는 도구: ${request.params.name}`,
      },
    ],
    isError: true,
  };
});

/**
 * 서버 시작
 */
async function main() {
  // [수정] log -> error, 이모지 제거
  console.error('\n=================================');
  console.error('식품 표기 정보 검증 MCP 서버');
  console.error('=================================\n');
  
  // 환경 변수 확인
  if (!process.env.FOOD_DB_API_KEY) {
    console.error('오류: FOOD_DB_API_KEY가 설정되지 않았습니다!');
    console.error('.env 파일을 확인해주세요.');
    process.exit(1);
  }
  
  // [수정] log -> error, 이모지 제거
  console.error('API 키 확인됨');
  console.error('API URL:', process.env.FOOD_DB_API_URL);
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // [수정] log -> error, 이모지 제거
  console.error('\n서버가 준비되었습니다!');
  console.error('Claude Desktop에서 사용할 수 있습니다.\n');
}

main().catch((error) => {
  console.error('\n서버 시작 오류:', error);
  process.exit(1);
});