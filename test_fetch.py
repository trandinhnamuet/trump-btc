
from truthbrush.api import Api
import json
api = Api(token='DdEKLNo5HI_U2uFiBaa9kY7oRmLIUcIyz0cRJmkAnR8')
posts = list(api.pull_statuses(username='realDonaldTrump', replies=False, verbose=False))
print(len(posts), 'posts')
if posts:
    print('ID:', posts[0]['id'])
    import re, html
    c = re.sub('<[^>]+>', '', posts[0].get('content', ''))
    print('Content:', html.unescape(c)[:200])
