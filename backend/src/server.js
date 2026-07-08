import app from './app.js';
import { assertJwtSecret } from './auth.js';

// Ohne sicheres JWT_SECRET nicht starten
assertJwtSecret();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Jugendfeuerwehr-Backend läuft auf Port ${PORT}`);
});
