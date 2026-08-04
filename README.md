# experimental_task_manager
An experimental commandlike taskmanager where you uncover images or ascii graphics by completing tasks. This way the user can condition himself and increase motivation to keep being productive. 

This web application is parted in two sides: One the taskmanagement, the other a reward system. I'm trying to experiment with ways on how to reward oneself when completing tasks.

## Running it
Just open `momentum.html` in a browser — no server required. Adding files to `ascii_art/` or `image_art/` and running `python3 build_art_data.py` afterwards is how they get picked up offline. If you instead run `python3 -m http.server` and open the printed address, new files in those folders show up on reload with no build step at all.
