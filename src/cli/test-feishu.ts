import { config } from '../config.js';
import { sendFeishuTest } from '../notifications/feishu.js';

await sendFeishuTest(config);
process.stdout.write('Feishu test notification delivered successfully.\n');
