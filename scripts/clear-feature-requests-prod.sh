#!/bin/bash

# SSH into production and run MongoDB command to clear old feature requests
ssh root@$PRODUCTION_SERVER << 'EOF'
cd $PRODUCTION_PATH
source .env

# Get today's date in ISO format
TODAY=$(date -u +"%Y-%m-%dT00:00:00.000Z")

echo "Clearing feature requests from before $TODAY"

# Run MongoDB command to delete old feature requests
mongosh "$MONGODB_URI" --eval "
  db = db.getSiblingDB('lanagent');
  
  // Count before deletion
  var totalBefore = db.featurerequests.countDocuments();
  var oldCount = db.featurerequests.countDocuments({
    submittedAt: { \$lt: ISODate('$TODAY') }
  });
  
  print('Total feature requests: ' + totalBefore);
  print('Feature requests before today: ' + oldCount);
  
  if (oldCount > 0) {
    // Delete old feature requests
    var result = db.featurerequests.deleteMany({
      submittedAt: { \$lt: ISODate('$TODAY') }
    });
    print('Deleted ' + result.deletedCount + ' feature requests');
  } else {
    print('No old feature requests to delete');
  }
  
  // Count remaining
  var remaining = db.featurerequests.countDocuments();
  print('Remaining feature requests: ' + remaining);
"
EOF