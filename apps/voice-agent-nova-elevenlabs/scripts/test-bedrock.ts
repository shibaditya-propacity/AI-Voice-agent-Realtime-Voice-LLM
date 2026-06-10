/**
 * Test: Bedrock Claude Sonnet 4.6 via @anthropic-ai/bedrock-sdk streaming
 */
import 'dotenv/config';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';

const ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID;
const SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const REGION     = process.env.AWS_REGION     ?? 'us-east-1';
const MODEL_ID   = process.env.LLM_MODEL_ID   ?? 'us.anthropic.claude-sonnet-4-6';

if (!ACCESS_KEY || !SECRET_KEY) {
  console.error('❌ AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY not set');
  process.exit(1);
}

const client = new AnthropicBedrock({
  awsRegion:    REGION,
  awsAccessKey: ACCESS_KEY,
  awsSecretKey: SECRET_KEY,
});

async function main(): Promise<void> {
  console.log(`\n🔵 Testing Bedrock Claude via @anthropic-ai/bedrock-sdk...`);
  console.log(`   Region   : ${REGION}`);
  console.log(`   Model ID : ${MODEL_ID}`);

  const start = Date.now();
  let firstTokenMs: number | null = null;
  let fullText = '';
  let chunkCount = 0;

  try {
    const stream = client.messages.stream({
      model:      MODEL_ID,
      max_tokens: 64,
      system:     'You are a concise assistant. Reply in 1-2 sentences only.',
      messages:   [{ role: 'user', content: 'Say exactly: "Bedrock Claude Sonnet 4.6 streaming is working."' }],
    });

    process.stdout.write('   Response : ');

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        const { text } = event.delta;
        fullText += text;
        chunkCount++;
        process.stdout.write(text);

        if (firstTokenMs === null) {
          firstTokenMs = Date.now() - start;
        }
      }
    }

    const final = await stream.finalMessage();
    const totalMs = Date.now() - start;

    console.log('\n');
    console.log(`✅ PASS — Bedrock Claude Sonnet 4.6 is working`);
    console.log(`   First token : ${firstTokenMs}ms`);
    console.log(`   Total time  : ${totalMs}ms`);
    console.log(`   Chunks      : ${chunkCount}`);
    console.log(`   Stop reason : ${final.stop_reason}`);
    console.log(`   Input tok   : ${final.usage.input_tokens}`);
    console.log(`   Output tok  : ${final.usage.output_tokens}`);

  } catch (err) {
    console.error(`\n❌ Bedrock error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
