## Hiding the cardPriority tag

The cardPriority tag is hidden by default using injected CSS (see user settings - Hide CardPriority Tag in Editor).

<img width="700" alt="image" src="https://github.com/user-attachments/assets/b69bb6d3-7948-4191-8df2-5bf02c24aa36" />


## Hiding cardPriority properties (priority and source)

If you want also to hide the slots (properties) - priority and source: You can hide these properties as you would for any other tag: enter it and change the property location to "At top of Document" or "Only in Table":

<img width="800" alt="image" src="https://github.com/user-attachments/assets/bae73752-1ed7-4982-948e-11c1b466517e" />

## Removing cardPriority tags and its properties

If you want to remove these tags (carPriority) and slots altogether of all your database, follow these steps:

- In your plugin settings, turn to the "[Light Mode](Full-Mode-x-Light-Mode.md)"
<img width="700" alt="image" src="https://github.com/user-attachments/assets/110d7e2f-4f78-41f2-8171-c7ae070aa4e4" />

- AFTER you change your settings to the "Light Mode", use the Omnibar to run the command "Remove All CardPriority Tags". The cardPriority tags and properties will be completely removed. 

<img width="700" alt="image" src="https://github.com/user-attachments/assets/803588e9-6a74-4732-aee4-bb33cee5159a" />


- Note 1: The command removes only flashcard priorities (stored in the cardPriority powerup). Incremental rems priorities are stored elsewhere (in the Incremental powerup) and will not be affected. (The plugin uses completely separated systems for the control of Incremental Rems priorities and flashcard priorities)
- Note 2: If you change to the "Full mode" again, the process of pre-tagging will happen again.

